import path from 'node:path';
import { stat, open, readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../util/persist';

export interface DsaSettings {
  enabled: boolean;
  mode: 'history' | 'submit';
  baseUrl: string;
  symbols: string[];
  intervalMs: number;
  timeoutMs: number;
  maxBytes: number;
  maxAgeMs: number;
  maxRecords: number;
  maxDaily: number;
  maxPolls: number;
  assumeUtc: boolean;
}
export function dsaSettings(env: NodeJS.ProcessEnv): DsaSettings {
  const boolean=(name:string):boolean=>{
    const raw=env[name] ?? 'false';
    if (!['true','false'].includes(raw)) throw new Error(`DSA: ${name} must be true or false`);
    return raw==='true';
  };
  const integer=(name:string,fallback:number,min:number,max:number):number=>{
    const n=env[name]===undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(n) || n<min || n>max || env[name]==='') throw new Error(`DSA: invalid ${name}`);
    return n;
  };
  const mode=env.DSA_MODE ?? 'history';
  if (mode!=='history' && mode!=='submit') throw new Error('DSA: invalid mode');
  const symbols=env.DSA_SYMBOLS ? env.DSA_SYMBOLS.split(',') : [];
  if (symbols.length>10 || new Set(symbols).size!==symbols.length || symbols.some(s=>!/^[A-Z0-9]{1,10}$/.test(s))) throw new Error('DSA: invalid symbol allowlist');
  const baseUrl=env.DSA_BASE_URL ?? 'http://127.0.0.1:8000';
  let url:URL;
  try {url=new URL(baseUrl);} catch {throw new Error('DSA: invalid origin');}
  const octets=url.hostname.split('.').map(Number);
  const privateHost=url.hostname==='[::1]' || (octets.length===4 && octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255) &&
    (octets[0]===127 || octets[0]===10 || (octets[0]===172 && octets[1]>=16 && octets[1]<=31) || (octets[0]===192 && octets[1]===168)));
  if (!privateHost || !['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('DSA: private credential-free origin required');
  const maxDaily=integer('DSA_MAX_DAILY',0,0,10);
  if (mode==='submit' && maxDaily===0) throw new Error('DSA: submit requires DSA_MAX_DAILY > 0');
  return {enabled:boolean('DSA_ENABLED'),mode,baseUrl:url.origin,symbols,
    intervalMs:integer('DSA_INTERVAL_SEC',300,10,86400)*1000,
    timeoutMs:integer('DSA_TIMEOUT_MS',5000,50,30000),maxBytes:integer('DSA_MAX_BYTES',262144,1024,1048576),
    maxAgeMs:integer('DSA_MAX_AGE_HOURS',48,1,168)*3600000,maxRecords:integer('DSA_MAX_RECORDS',100,1,500),
    maxDaily,maxPolls:integer('DSA_MAX_POLLS',30,1,100),assumeUtc:boolean('DSA_ASSUME_UTC')};
}

const actions = ['buy','add','hold','reduce','sell','watch','avoid','alert'] as const;
type Action = typeof actions[number];
function object(value:unknown):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid_report');
  return value as Record<string,unknown>;
}
function id(value:unknown):string {
  if (typeof value!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid_report');
  return value;
}
export interface ResearchRecord {
  symbol: string;
  queryId: string;
  reportId: number | null;
  createdAt: number;
  receivedAt: number;
  action: Action | null;
  sentimentScore: number | null;
}
interface Universe {dataDir:string;symbols:string[];assetClass(symbol:string):string}
interface Task {symbol:string;taskId:string;polls:number;done:boolean}
interface Daily {day:string;attempted:string[];tasks:Task[]}
interface Saved {version:1;records:ResearchRecord[];daily:Daily}
export class ShadowResearch {
  private records: ResearchRecord[] = [];
  private daily:Daily={day:'',attempted:[],tasks:[]};
  private running = false;
  private timer:NodeJS.Timeout|null=null;
  private active:Promise<void>|null=null;
  private initializing:Promise<void>|null=null;
  private abort=new AbortController();
  private lastError: string | null = null;
  private file: string;
  constructor(private settings:DsaSettings, private universe:Universe, private clock=Date.now) {
    this.file=path.join(universe.dataDir,'dsa-research.json');
  }
  start(schedule=true):Promise<void> {
    if(this.initializing) return this.initializing;
    if(this.running) return Promise.resolve();
    const controller=new AbortController();
    this.abort=controller;
    this.initializing=this.initialize(schedule,controller).finally(()=>{this.initializing=null;});
    return this.initializing;
  }
  private async initialize(schedule:boolean,controller:AbortController):Promise<void> {
    try {
      const size=await stat(this.file).then(s=>s.size).catch(error=>{if(error.code==='ENOENT') return null;throw error;});
      if(size!==null) {
        if(size>524288) throw new Error('storage_error');
        this.restore(JSON.parse(await readFile(this.file,'utf8')));
      }
    } catch {this.lastError='storage_error';return;}
    if(controller.signal.aborted) return;
    this.running=true;
    if(schedule && this.settings.enabled) {
      this.timer=setInterval(()=>void this.tick(),this.settings.intervalMs);
      this.timer.unref();
      void this.tick();
    }
  }
  async stop():Promise<void> {
    this.running=false;
    if(this.timer) clearInterval(this.timer);
    this.timer=null;
    this.abort.abort();
    await this.initializing;
    await this.active;
  }
  snapshot() {
    return {running:this.running,enabled:this.settings.enabled,shadowOnly:true as const,mode:this.settings.mode,
      lastError:this.lastError,budgetDay:this.daily.day,dailyCap:this.settings.maxDaily,attemptedToday:this.daily.attempted.length,
      pendingTasks:this.daily.tasks.filter(t=>!t.done && t.polls<this.settings.maxPolls).length,
      exhaustedTasks:this.daily.tasks.filter(t=>!t.done && t.polls>=this.settings.maxPolls).length,
      ambiguousSubmissions:this.daily.attempted.filter(s=>!this.daily.tasks.some(t=>t.symbol===s)).length,
      records:this.records.filter(r=>this.eligible(r.symbol)).map(r=>({...r,stale:this.clock()-r.createdAt>this.settings.maxAgeMs || r.createdAt>this.clock()+60_000}))};
  }
  private eligible(symbol:string):boolean {
    return this.settings.symbols.includes(symbol) && this.universe.symbols.includes(symbol) && this.universe.assetClass(symbol)==='stock';
  }
  private restore(value:unknown):void {
    const saved=object(value),daily=object(saved.daily);
    if(saved.version!==1 || !Array.isArray(saved.records) || saved.records.length>500 ||
      typeof daily.day!=='string' || !/^(?:|\d{4}-\d{2}-\d{2})$/.test(daily.day) ||
      !Array.isArray(daily.attempted) || daily.attempted.length>10 || new Set(daily.attempted).size!==daily.attempted.length ||
      !Array.isArray(daily.tasks) || daily.tasks.length>10) throw new Error('storage_error');
    const symbol=(v:unknown):string=>{if(typeof v!=='string' || !/^[A-Z0-9]{1,10}$/.test(v)) throw new Error('storage_error');return v;};
    const attempted=daily.attempted.map(symbol);
    const tasks=daily.tasks.map(value=>{
      const t=object(value);
      if(!attempted.includes(symbol(t.symbol)) || !Number.isSafeInteger(t.polls) || Number(t.polls)<0 || Number(t.polls)>100 || typeof t.done!=='boolean') throw new Error('storage_error');
      return {symbol:symbol(t.symbol),taskId:id(t.taskId),polls:Number(t.polls),done:t.done};
    });
    if(new Set(tasks.map(t=>t.symbol)).size!==tasks.length) throw new Error('storage_error');
    this.daily={day:daily.day,attempted,tasks};
    this.records=saved.records.map(value=>{
      const r=object(value);
      if(!Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.receivedAt) || Number(r.createdAt)<=0 || Number(r.receivedAt)<=0 ||
        (r.reportId!==null && (!Number.isSafeInteger(r.reportId) || Number(r.reportId)<1)) ||
        (r.action!==null && !actions.includes(r.action as Action)) ||
        (r.sentimentScore!==null && !Number.isSafeInteger(r.sentimentScore))) throw new Error('storage_error');
      return {symbol:symbol(r.symbol),queryId:id(r.queryId),reportId:r.reportId as number|null,createdAt:Number(r.createdAt),receivedAt:Number(r.receivedAt),action:r.action as Action|null,sentimentScore:r.sentimentScore as number|null};
    }).slice(-this.settings.maxRecords);
  }
  private async persist():Promise<void> {
    this.records=this.records.slice(-this.settings.maxRecords);
    try {
      await writeJsonAtomic(this.file,{version:1,records:this.records,daily:this.daily} satisfies Saved);
      // Paid intent must survive a machine crash, not merely an atomic rename.
      for(const name of [this.file,path.dirname(this.file)]) {
        const handle=await open(name,'r');
        try {await handle.sync();} finally {await handle.close();}
      }
    } catch {this.running=false;throw new Error('storage_error');}
  }
  private async submitTick(symbol:string):Promise<void> {
    const day=new Date(this.clock()).toISOString().slice(0,10);
    if(day>this.daily.day) this.daily={day,attempted:[],tasks:[]};
    // A clock rollback never replenishes a paid budget.
    if(day!==this.daily.day) return;
    const task=this.daily.tasks.find(t=>t.symbol===symbol);
    if(task) {
      if(task.done || task.polls>=this.settings.maxPolls) return;
      task.polls++;
      await this.persist();
      const status=object(await this.request(symbol,`/api/v1/analysis/status/${task.taskId}`));
      if(status.task_id!==task.taskId || !['pending','processing','completed','failed','cancel_requested','cancelled'].includes(String(status.status))) throw new Error('invalid_report');
      if(['failed','cancelled','cancel_requested'].includes(String(status.status))) {task.done=true;await this.persist();throw new Error('task_failed');}
      if(status.status==='completed') {
        task.done=true;
        await this.persist();
        const result=object(status.result);
        if(result.stock_code!==symbol || result.query_id!==task.taskId) throw new Error('invalid_report');
        const record=this.parseReport(result.report,symbol,task.taskId,null);
        this.records.push(record);
        await this.persist();
      }
      return;
    }
    if(this.daily.attempted.includes(symbol) || this.daily.attempted.length>=this.settings.maxDaily) return;
    this.daily.attempted.push(symbol);
    // Charge intent durably BEFORE POST: a timeout/crash is an ambiguous paid submission, never retried today.
    await this.persist();
    if(new Date(this.clock()).toISOString().slice(0,10)!==day) return;
    const accepted=object(await this.request(symbol,'/api/v1/analysis/analyze',{stock_code:symbol,async_mode:true,notify:false,force_refresh:false,report_language:'en'}));
    if(!['pending','processing'].includes(String(accepted.status))) throw new Error('invalid_report');
    this.daily.tasks.push({symbol,taskId:id(accepted.task_id),polls:0,done:false});
    await this.persist();
  }
  private async request(symbol:string,route:string, body?:unknown):Promise<unknown> {
    if(!this.running || !this.eligible(symbol)) throw new Error('invalid_report');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.settings.timeoutMs);
    try {
      const response=await fetch(`${this.settings.baseUrl}${route}`,{method:body===undefined?'GET':'POST',
        headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
        body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([controller.signal,this.abort.signal])});
      if (![200,202].includes(response.status) || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
          Number(response.headers.get('content-length'))>this.settings.maxBytes || !response.body) {
        await response.body?.cancel();throw new Error('transport_error');
      }
      const reader=response.body.getReader();
      const chunks:Uint8Array[]=[];let size=0;
      try {
        for (;;) {
          const {done,value}=await reader.read();
          if(done) break;
          size+=value.byteLength;
          if(size>this.settings.maxBytes) throw new Error('transport_error');
          chunks.push(value);
        }
      } finally {await reader.cancel();}
      if(!this.running || !this.eligible(symbol)) throw new Error('invalid_report');
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {throw new Error('transport_error');}
    finally {clearTimeout(timer);}
  }
  private parseReport(value:unknown,symbol:string,query:string,reportId:number|null):ResearchRecord {
    const report=object(value), meta=object(report.meta), summary=object(report.summary);
    if (meta.stock_code!==symbol || meta.query_id!==query || (reportId!==null && meta.id!==reportId) ||
        (meta.asset_type!=null && meta.asset_type!=='stock') || meta.report_type==='market_review') throw new Error('invalid_report');
    let text=meta.created_at;
    if (this.settings.assumeUtc && typeof text==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(text)) text+='Z';
    if (typeof text!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error('invalid_report');
    const calendar=Date.parse(text.slice(0,10)+'T00:00:00Z');
    if(!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0,10)!==text.slice(0,10) ||
      Number(text.slice(11,13))>23 || Number(text.slice(14,16))>59 || Number(text.slice(17,19))>59) throw new Error('invalid_report');
    const createdAt=Date.parse(text), age=this.clock()-createdAt;
    if (!Number.isFinite(createdAt) || age>this.settings.maxAgeMs || age < -60_000) throw new Error('invalid_report');
    if (summary.action!=null && !actions.includes(summary.action as Action)) throw new Error('invalid_report');
    if (summary.sentiment_score!=null && (typeof summary.sentiment_score!=='number' || !Number.isSafeInteger(summary.sentiment_score))) throw new Error('invalid_report');
    return {symbol,queryId:query,reportId,createdAt,receivedAt:this.clock(),action:summary.action as Action ?? null,sentimentScore:summary.sentiment_score as number ?? null};
  }
  async tick():Promise<void> {
    if (!this.running || !this.settings.enabled || this.active) return;
    this.active=this.work();
    try {await this.active;} finally {this.active=null;}
  }
  private async work():Promise<void> {
    for (const symbol of this.settings.symbols) {
      if (!this.running || !this.eligible(symbol)) continue;
      try {
        if(this.settings.mode==='submit') {await this.submitTick(symbol);this.lastError=null;continue;}
        const list=object(await this.request(symbol,`/api/v1/history?stock_code=${symbol}&page=1&limit=1`));
        if (!Array.isArray(list.items) || list.items.length>1) throw new Error('invalid_report');
        if (!list.items.length) continue;
        const item=object(list.items[0]);
        if (item.stock_code!==symbol || !Number.isSafeInteger(item.id) || Number(item.id)<1) throw new Error('invalid_report');
        const query=id(item.query_id);
        const report=await this.request(symbol,`/api/v1/history/${item.id}`);
        if(!this.running || !this.eligible(symbol)) continue;
        const record=this.parseReport(report,symbol,query,Number(item.id));
        if (!this.records.some(r=>r.symbol===symbol && r.queryId===record.queryId && r.reportId===record.reportId)) this.records.push(record);
        await this.persist();
        this.lastError=null;
      } catch (error) {this.lastError=error instanceof Error && ['transport_error','storage_error','task_failed'].includes(error.message)?error.message:'invalid_report';}
    }
  }
}
