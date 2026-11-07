import { ShieldCheck, Clock3, CircleAlert } from "lucide-react";
import { eligible, patState, patLabels, type Account } from "./types";
export type Category = "all" | "available" | "invalid" | "unknown" | "workbuddy" | "pat" | "pending";
export const categoryLabels = {all:"全部账号",available:"可用",invalid:"失效",unknown:"未知",workbuddy:"WorkBuddy2api",pat:"PAT 专用",pending:"任务占用"} as const;
const categoryDescriptions: Partial<Record<Category,string>> = {available:'检测为公开可访问，不代表未被任务占用',invalid:'检测为公开不可访问，可能更名、删除或受限',unknown:'检测失败或请求受限，无法判断是否可访问',pending:'任务仍保留占用的账号，暂不可重复选用；包含等待人工处理的任务'};
export function taskOwner(a: Account): 'unassigned' | 'workbuddy' | 'pat' | 'other' {
  return a.taskSummary?.owner || (a.patDedicated ? 'pat' : a.selectedAt || a.reservedBy ? 'other' : 'unassigned');
}
export function matchesCategory(a: Account, category: Category): boolean {
  if(a.deletedAt)return false;
  switch(category) {
    case 'all': return true;
    case 'available': return a.publicStatus==='reachable';
    case 'invalid': return a.publicStatus==='missing';
    case 'unknown': return ['limited','error'].includes(a.publicStatus);
    case 'pending': return a.reservedBy!==null && a.reservedBy!==undefined;
    default: return taskOwner(a)===category;
  }
}
export function categoryCounts(rows: Account[]) {
  const counts={all:0,available:0,invalid:0,unknown:0,workbuddy:0,pat:0,pending:0};
  for(const a of rows)for(const category of Object.keys(counts) as Category[])if(matchesCategory(a,category))counts[category]++;
  return counts;
}
export function patStateCounts(rows: Account[]) {
  const counts={preparing:0,valid:0,cooling:0,invalid:0,manual:0,disabled:0};
  for(const a of rows) if(!a.deletedAt && a.patDedicated) counts[patState(a.pat?.status)]++;
  return counts;
}
export const taskFilterOptions: Partial<Record<Category,Record<string,string>>> = {
  workbuddy:{all:'全部任务状态',queued:'待执行',running:'执行中',manual:'待人工处理',linked:'已关联',external:'外部已登记'},
  pat:{all:'全部 PAT 状态',pending:'待准备',preparing:'准备中',verifying:'待验证',valid:'可用',cooling:'额度冷却',manual:'需处理',invalid:'已失效',disabled:'已停用'},
};
export function candidateAllowed(a:Account,kind:'workbuddy'|'pat') {
  const fresh=!!a.checkedAt && Date.parse(a.checkedAt)>=Date.now()-86400000;
  if(!fresh || a.publicStatus!=='reachable' || !a.hasTotp)return false;
  return a.taskSummary ? (kind==='pat'?a.taskSummary.canPat:a.taskSummary.canWorkbuddy) : eligible(a);
}
export function matchesTaskFilter(a:Account,category:Category,filter:string) {
  if(filter==='all')return true;
  return (a.taskSummary?.state || (category==='pat'?a.pat?.status:undefined))===filter;
}
export function candidateReason(a:Account) {
  if(!a.hasTotp)return '未保存 TOTP 密钥';
  if(a.publicStatus==='unchecked')return '尚未检测';
  if(a.publicStatus!=='reachable')return '需检测为公开可访问';
  if(!a.checkedAt || Date.parse(a.checkedAt)<Date.now()-86400000)return '检测结果已超过 24 小时';
  return a.taskSummary?.candidateReason || '满足基本条件';
}
export function AccountCategories({accounts,value,onChange}:{accounts:Account[];value:Category;onChange:(category:Category)=>void}) {
  const counts=categoryCounts(accounts);
  return <div className="tabs account-categories" role="group" aria-label="账号分类">{(Object.entries(categoryLabels) as [Category,string][]).map(([id,label])=><button key={id} title={categoryDescriptions[id]} aria-pressed={value===id} className={`tab ${value===id?"active":""}`} onClick={()=>onChange(id)}>{label}<span>{counts[id]}</span></button>)}</div>;
}
export function PatBadge({account}:{account:Pick<Account,"patDedicated"|"pat">}) {
  if(!account.patDedicated)return null;
  const state=patState(account.pat?.status);
  const Icon=state==="valid"?ShieldCheck:state==="cooling"||state==="preparing"?Clock3:CircleAlert;
  return <div className="pat-badges"><span className="badge pat-purpose"><ShieldCheck size={13}/>PAT 专用</span><span className={`badge pat-${state}`}><Icon size={13}/>{account.pat?.status==="verifying"?"已保存 · 待验证":patLabels[state]}</span></div>;
}
