import React,{useEffect,useState,useCallback,useRef} from 'react';
import{createRoot}from'react-dom/client';
import{ArrowLeft,ArrowRight,Check,Download,FolderOpen,Image as ImageIcon,LogOut,Maximize,Minus,Plus,RotateCcw,Settings,ShieldCheck,X}from'lucide-react';
import './style.css';

type Auth={token:string,user_id:string,role:'reader'|'admin'};
type CaseInfo={done:boolean,case_id:string|null,slices:string[],dataset_version:number,completed:number,total:number};
type Result={reader_id:string,case_id:string,verdict:string,dataset_version:number,submitted_at:string};
type DatasetSettings={folder:string,dataset_version:number,cases:number,source:'mount'|'import'};
type SliceRequest={controller:AbortController,promise:Promise<string>,url?:string};
const api=async(path:string,auth?:Auth,options:RequestInit={})=>{
 const res=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth.token}:{}),...options.headers}});
 if(!res.ok){let message=`HTTP ${res.status}`;try{message=(await res.json()).detail||message}catch{}throw new Error(message)}
 return res;
};
const json=async(path:string,auth?:Auth,options:RequestInit={})=>(await api(path,auth,options)).json();
type SetupStatus={required:boolean,user_id:string};

function App(){
 const [auth,setAuth]=useState<Auth|null>(null);
 const [setup,setSetup]=useState<SetupStatus|null>(null);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);

 const checkSetup=useCallback(async()=>{
  setError('');
  try{setSetup(await json('/setup'))}
  catch(error){setError(String(error))}
 },[]);
 useEffect(()=>{void checkSetup()},[checkSetup]);

 const logout=async()=>{
  if(auth)try{await api('/logout',auth,{method:'POST'})}catch{}
  setAuth(null);
  setError('');
 };
 const submit=async(event:React.FormEvent<HTMLFormElement>)=>{
  event.preventDefault();
  if(!setup)return;
  const fields=new FormData(event.currentTarget);
  const password=fields.get('password');
  if(setup.required&&password!==fields.get('confirm_password')){
   setError('Οι κωδικοί δεν ταιριάζουν.');
   return;
  }
  setBusy(true);
  setError('');
  try{
   if(setup.required){
    await json('/setup',undefined,{method:'POST',body:JSON.stringify({password})});
    setSetup({...setup,required:false});
   }
   const user_id=setup.required?setup.user_id:fields.get('user_id');
   setAuth(await json('/login',undefined,{method:'POST',body:JSON.stringify({user_id,password})}));
  }catch(error){
   if(setup.required)await checkSetup();
   setError(String(error));
  }finally{setBusy(false)}
 };

 return <div className="app">
  <header>
   <div className="brand"><ShieldCheck size={27}/> <strong>Synthetic MRI Reader</strong><span>Quality assessment</span></div>
   {auth&&<div className="user">{auth.user_id}<span className="role">{auth.role==='admin'?'Administrator':'Radiologist'}</span><button className="ghost" onClick={logout}><LogOut size={17}/> Έξοδος</button></div>}
  </header>
  {auth?(auth.role==='admin'?<Admin auth={auth}/>:<Viewer auth={auth}/>):
   <main className="login-wrap">
    {!setup?<div className="login card">
     {error?<><p className="error">{error}</p><button className="secondary" onClick={checkSetup}>Δοκιμάστε ξανά</button></>:<p>Φόρτωση...</p>}
    </div>:<form key={String(setup.required)} className="login card" onSubmit={submit}>
     <div className="logo">{setup.required?<ShieldCheck size={35}/>:<ImageIcon size={35}/>}</div>
     <h1>{setup.required?'Αρχική ρύθμιση διαχειριστή':'Αξιολόγηση MRI'}</h1>
     <p>{setup.required?'Ορίστε τον κωδικό πρόσβασης του διαχειριστή.':'Συνδεθείτε με τον προσωπικό σας κωδικό για να ξεκινήσετε.'}</p>
     <label>Αναγνωριστικό χρήστη<input name="user_id" autoComplete="username" defaultValue={setup.required?setup.user_id:''} readOnly={setup.required} placeholder="π.χ. RAD001" required/></label>
     <label>Κωδικός πρόσβασης<input name="password" type="password" autoComplete={setup.required?'new-password':'current-password'} minLength={setup.required?12:undefined} maxLength={setup.required?256:undefined} required/></label>
     {setup.required&&<label>Επιβεβαίωση κωδικού (τουλάχιστον 12 χαρακτήρες)<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required/></label>}
     {error&&<p className="error" role="alert">{error}</p>}
     <button disabled={busy} className="primary">{busy?'Παρακαλώ περιμένετε...':setup.required?'Δημιουργία διαχειριστή':'Είσοδος στην εφαρμογή'} <ArrowRight size={18}/></button>
    </form>}
   </main>}
 </div>
}
function Viewer({auth}:{auth:Auth}){
 const[entry,setEntry]=useState<CaseInfo|null>(null);const[index,setIndex]=useState(0);const[busy,setBusy]=useState(false);const[error,setError]=useState('');const[zoom,setZoom]=useState(1);const[pos,setPos]=useState({x:0,y:0});
 const[failed,setFailed]=useState<{entry:CaseInfo,index:number}|null>(null);
 const[,updateSlices]=useState(0);
 const cached=useRef<Map<number,SliceRequest>>(new Map());
 const drag=useRef<{x:number,y:number,px:number,py:number}|null>(null);
 const viewport=useRef<HTMLDivElement>(null);
 const load=useCallback(async()=>{setError('');try{const data:CaseInfo=await json('/reader/next',auth);setEntry(data);setIndex(0);setZoom(1);setPos({x:0,y:0});setFailed(null)}catch(e){setError(String(e))}},[auth]);
 useEffect(()=>{load()},[load]);
 useEffect(()=>{
  const slices=cached.current;
  return ()=>{
   for(const slice of slices.values()){
    slice.controller.abort();
    if(slice.url)URL.revokeObjectURL(slice.url);
   }
   cached.current=new Map();
  };
 },[entry]);
 useEffect(()=>{
  if(!entry?.case_id)return;
  const slices=cached.current;
  for(const [position,slice] of slices){
   if(Math.abs(position-index)<=12)continue;
   slice.controller.abort();
   if(slice.url)URL.revokeObjectURL(slice.url);
   slices.delete(position);
  }
  const requestSlice=(position:number)=>{
   const existing=slices.get(position);
   if(existing)return existing.promise;
   const controller=new AbortController();
   const path=`/reader/image/${encodeURIComponent(entry.case_id!)}/${encodeURIComponent(entry.slices[position])}?version=${entry.dataset_version}`;
   const slice:SliceRequest={controller,promise:api(path,auth,{signal:controller.signal}).then(async response=>{
    const blob=await response.blob();
    controller.signal.throwIfAborted();
    const url=URL.createObjectURL(blob);
    try{
     const image=new Image();
     image.src=url;
     await image.decode();
     controller.signal.throwIfAborted();
     slice.url=url;
     return url;
    }catch(error){
     URL.revokeObjectURL(url);
     throw error;
    }
   }).catch(error=>{
    if(slices.get(position)===slice)slices.delete(position);
    throw error;
   })};
   slices.set(position,slice);
   return slice.promise;
  };
  let live=true;
  requestSlice(index).then(()=>{
   if(live)updateSlices(value=>value+1);
  }).catch(()=>{
   if(live)setFailed({entry,index});
  });
  for(const position of [index+1,index-1,index+2,index+3]){
   if(position>=0&&position<entry.slices.length)requestSlice(position).catch(()=>{});
  }
  return()=>{live=false};
 },[entry,index,auth]);
 const cacheEntry=useRef(entry);
 useEffect(()=>{cacheEntry.current=entry},[entry]);
 const img=cacheEntry.current===entry?cached.current.get(index)?.url:undefined;
 const imageFailed=failed?.entry===entry&&failed?.index===index;
 const loading=!img&&!imageFailed;
 const move=useCallback((delta:number)=>{setIndex(v=>Math.max(0,Math.min((entry?.slices.length||1)-1,v+delta)))},[entry]);
 useEffect(()=>{const f=(e:KeyboardEvent)=>{if(e.target instanceof HTMLInputElement)return;if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();move(1)}if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();move(-1)}};window.addEventListener('keydown',f);return()=>window.removeEventListener('keydown',f)},[move]);
 const submit=async(verdict:'accept'|'reject')=>{if(!entry?.case_id||busy)return;setBusy(true);setError('');try{await json('/reader/evaluate',auth,{method:'POST',body:JSON.stringify({case_id:entry.case_id,dataset_version:entry.dataset_version,verdict})});await load()}catch(e){setError(String(e))}finally{setBusy(false)}};
 if(!entry)return <main className="centered">Φόρτωση περιστατικών... {error}</main>;
 if(entry.done)return <main className="centered"><div className="card finished"><Check size={48} color="#159652"/><h2>Ολοκληρώθηκε η αξιολόγηση</h2><p>Έχουν αξιολογηθεί {entry.completed} από {entry.total} περιστατικά.</p><button className="secondary" onClick={load}>Ανανέωση</button>{error&&<p className="error">{error}</p>}</div></main>;
 return <main className="review"><section className="case-top"><div><div className="eyebrow">CURRENT CASE</div><h2>{entry.case_id}</h2></div><div className="progress"><strong>{entry.completed+1} / {entry.total}</strong> περιστατικά<div className="progress-bar"><div style={{width:`${entry.total?100*entry.completed/entry.total:0}%`}}/></div></div></section><section className="workspace"><aside className="slice-info card"><div className="eyebrow">MRI STACK</div><h3>{entry.slices.length} images</h3><div className="slice-count">Slice <strong>{index+1}</strong> / {entry.slices.length}</div><input aria-label="Slice position" type="range" min={0} max={Math.max(0,entry.slices.length-1)} value={index} onChange={e=>setIndex(+e.target.value)} /><div className="hint">Ροδέλα ποντικιού ή πλήκτρα ← → για αλλαγή slice.</div></aside><div className="viewer" ref={viewport} onWheel={e=>{e.preventDefault();move(e.deltaY>0?1:-1)}} onPointerDown={e=>{if(e.button!==0||(e.target instanceof Element&&e.target.closest('button')))return;drag.current={x:e.clientX,y:e.clientY,px:pos.x,py:pos.y};e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(drag.current)setPos({x:drag.current.px+e.clientX-drag.current.x,y:drag.current.py+e.clientY-drag.current.y})}} onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}><div className="viewer-caption">{entry.case_id} <span> • {entry.slices[index]}</span></div>{imageFailed&&!img?<div className="image-loading">Αδυναμία φόρτωσης εικόνας <button className="secondary" onClick={load}>Ανανέωση</button></div>:loading?<div className="image-loading">Φόρτωση εικόνας...</div>:img?<img draggable={false} alt={`MRI slice ${index+1}`} src={img} style={{transform:`translate(${pos.x}px,${pos.y}px) scale(${zoom})`}}/>:null}<button aria-label="Previous slice" className="nav left" onClick={()=>move(-1)} disabled={index===0}><ArrowLeft/></button><button aria-label="Next slice" className="nav right" onClick={()=>move(1)} disabled={index===entry.slices.length-1}><ArrowRight/></button><div className="tools"><button aria-label="Zoom out" onClick={()=>setZoom(v=>Math.max(0.25,v-0.2))}><Minus size={17}/></button><span>{Math.round(zoom*100)}%</span><button aria-label="Zoom in" onClick={()=>setZoom(v=>Math.min(5,v+0.2))}><Plus size={17}/></button><button title="Reset zoom and pan" onClick={()=>{setZoom(1);setPos({x:0,y:0})}}><RotateCcw size={17}/></button><button title="Fullscreen" onClick={()=>{viewport.current?.requestFullscreen?.()}}><Maximize size={17}/></button></div></div><aside className="decision card"><div className="eyebrow">CASE ASSESSMENT</div><h3>Είναι η MRI αποδεκτή;</h3><p>Η απόφαση αφορά ολόκληρο το MRI stack.</p><button className="accept" disabled={busy||!img} onClick={()=>submit('accept')}><Check size={20}/> Αποδεκτή</button><button className="reject" disabled={busy||!img} onClick={()=>submit('reject')}><X size={20}/> Μη αποδεκτή</button><p className="hint">Με την υποβολή καταγράφεται η κρίση και ανοίγει το επόμενο περιστατικό.</p>{error&&<p className="error">{error}</p>}</aside></section></main>
}
function Admin({auth}:{auth:Auth}){
 const[tab,setTab]=useState<'settings'|'results'>('settings');const[folder,setFolder]=useState('cases');const[data,setData]=useState<DatasetSettings|null>(null);const[results,setResults]=useState<{rows:Result[],readers:string[],current_version:number,current_cases:number}|null>(null);const[message,setMessage]=useState('');const[error,setError]=useState('');const[filter,setFilter]=useState('');
 const refresh=useCallback(async()=>{try{const [settings,report]=await Promise.all([json('/admin/settings',auth),json('/admin/results',auth)]);setData(settings);setFolder(settings.source==='mount'&&settings.folder||'cases');setResults(report)}catch(e){setError(String(e))}},[auth]);useEffect(()=>{refresh()},[refresh]);
 const run=async(fn:()=>Promise<unknown>)=>{setMessage('');setError('');try{await fn();setMessage('Η ενέργεια ολοκληρώθηκε.');await refresh()}catch(e){setError(String(e))}};
 const download=async()=>{try{const response=await api('/admin/export.csv',auth);const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='mri_evaluations.csv';a.click();URL.revokeObjectURL(url)}catch(e){setError(String(e))}};
 const picker=useRef<HTMLInputElement>(null);
 const [upload,setUpload]=useState<{completed:number,total:number}|null>(null);
 const importFolder=async(selection:FileList|null)=>{
  const files=Array.from(selection??[]).flatMap(file=>{
   const parts=file.webkitRelativePath.split('/');
   if(parts.length!==3||!/\.png$/i.test(file.name))return [];
   return [{file,caseName:parts[1],root:parts[0]}];
  });
  setError('');
  setMessage('');
  if(!files.length){
   setError('Επιλέξτε φάκελο με υποφακέλους περιστατικών που περιέχουν αρχεία PNG.');
   return;
  }
  if(files.some(({file})=>file.size>64*1024*1024)){
   setError('Κάθε PNG πρέπει να έχει μέγεθος έως 64 MiB.');
   return;
  }
  if(!window.confirm('Η εισαγωγή δημιουργεί νέα έκδοση dataset. Οι προηγούμενες αξιολογήσεις διατηρούνται. Συνέχεια;'))return;
  setUpload({completed:0,total:files.length});
  let path:string|undefined;
  const controller=new AbortController();
  try{
   const {upload_id}=await json('/admin/imports',auth,{method:'POST'});
   const importPath='/admin/imports/'+upload_id;
   path=importPath;
   let next=0;
   const sendFiles=async()=>{
    try{
     while(!controller.signal.aborted&&next<files.length){
      const {file,caseName}=files[next++];
      const query=new URLSearchParams({case:caseName,filename:file.name});
      await api(importPath+'/slice?'+query,auth,{
       method:'PUT',
       headers:{'Content-Type':'application/octet-stream'},
       body:file,
       signal:controller.signal,
      });
      setUpload(progress=>progress&&{...progress,completed:progress.completed+1});
     }
    }catch(error){
     controller.abort(error);
    }
   };
   await Promise.all(Array.from({length:Math.min(6,files.length)},sendFiles));
   controller.signal.throwIfAborted();
   await json(importPath+'/finish',auth,{
    method:'POST',
    body:JSON.stringify({folder:files[0].root,files:files.length}),
   });
   path=undefined;
   setMessage('Το dataset εισήχθη και ενεργοποιήθηκε.');
   await refresh();
  }catch(error){
   if(path)await api(path,auth,{method:'DELETE'}).catch(()=>{});
   setError(String(error));
  }finally{
   setUpload(null);
  }
 };
 return <main className="admin"><aside className="admin-nav"><button className={tab==='settings'?'selected':''} onClick={()=>setTab('settings')}><Settings size={18}/> Ρυθμίσεις</button><button className={tab==='results'?'selected':''} onClick={()=>setTab('results')}><ImageIcon size={18}/> Αποτελέσματα</button></aside><div className="admin-main">{tab==='settings'?<><h1>Ρυθμίσεις συστήματος</h1><p className="subtitle">Διαχείριση περιστατικών και λογαριασμών ακτινολόγων.</p><section className="card admin-card"><div className="heading"><FolderOpen/><h2>Κεντρικός φάκελος περιστατικών</h2></div><p>Επιλέξτε τον φάκελο που περιέχει τους υποφακέλους περιστατικών. Κάθε υποφάκελος πρέπει να περιέχει τα PNG του περιστατικού.</p>
 <input type="file" hidden ref={element=>{picker.current=element;element?.setAttribute('webkitdirectory','')}} onChange={event=>{void importFolder(event.currentTarget.files);event.currentTarget.value=''}}/>
 <button type="button" className="primary" disabled={upload!==null} onClick={()=>picker.current?.click()}><FolderOpen size={18}/> Επιλογή φακέλου από τον υπολογιστή</button>
 {upload&&<p role="status">Μεταφόρτωση PNG · {upload.completed} / {upload.total}</p>}
 <details><summary>Χρήση φακέλου του server</summary>
 <p>Δώστε σχετική διαδρομή μέσα στον φάκελο δεδομένων του server (<code>/data</code>).</p><form onSubmit={e=>{e.preventDefault();if(window.confirm('Η αλλαγή φακέλου δημιουργεί νέα έκδοση dataset. Οι προηγούμενες αξιολογήσεις διατηρούνται. Συνέχεια;'))run(()=>json('/admin/settings',auth,{method:'PUT',body:JSON.stringify({folder})}))}}><label>Διαδρομή φακέλου<input value={folder} onChange={e=>setFolder(e.target.value)} placeholder="cases" required/></label><button className="primary" disabled={upload!==null}>Αποθήκευση dataset</button></form></details><div className="meta">Ενεργή έκδοση: {data?.dataset_version??'—'} · Περιστατικά: {data?.cases??'—'}{data?.folder&&<> · Φάκελος: {data.folder}</>}</div></section><section className="card admin-card"><div className="heading"><ShieldCheck/><h2>Προσθήκη ακτινολόγου</h2></div><form onSubmit={e=>{e.preventDefault();const f=e.currentTarget;const values=new FormData(f);run(async()=>{await json('/admin/readers',auth,{method:'POST',body:JSON.stringify({user_id:values.get('reader'),password:values.get('password')})});f.reset()})}}><label>Μοναδικό Reader ID<input name="reader" minLength={3} pattern="[A-Za-z0-9_-]+" placeholder="RAD001" required/></label><label>Προσωπικός κωδικός (τουλάχιστον 10 χαρακτήρες)<input name="password" type="password" minLength={10} required/></label><button className="primary">Δημιουργία λογαριασμού</button></form></section><AdminPassword auth={auth}/>{message&&<p className="success">{message}</p>}{error&&<p className="error">{error}</p>}</>:<><div className="results-head"><div><h1>Αποτελέσματα αξιολογήσεων</h1><p className="subtitle">Ατομικές αποφάσεις όλων των αναγνωστών, με ιστορικό έκδοσης dataset.</p></div><button className="primary" onClick={download}><Download size={17}/> Εξαγωγή CSV</button></div><section className="stats"><div className="card"><div>Ακτινολόγοι</div><strong>{results?.readers.length??0}</strong></div><div className="card"><div>Τρέχοντα περιστατικά</div><strong>{results?.current_cases??0}</strong></div><div className="card"><div>Αξιολογήσεις συνολικά</div><strong>{results?.rows.length??0}</strong></div></section><div className="card results-table"><div className="table-top"><h2>Καταγεγραμμένες κρίσεις</h2><input placeholder="Αναζήτηση reader / case..." value={filter} onChange={e=>setFilter(e.target.value)}/></div><div className="scroll"><table><thead><tr><th>Reader ID</th><th>Dataset</th><th>Case ID</th><th>Αξιολόγηση</th><th>Ημερομηνία (UTC)</th></tr></thead><tbody>{results?.rows.filter(r=>r.reader_id.toLowerCase().includes(filter.toLowerCase())||r.case_id.toLowerCase().includes(filter.toLowerCase())).map((r,i)=><tr key={`${r.reader_id}-${r.dataset_version}-${r.case_id}-${i}`}><td>{r.reader_id}</td><td>v{r.dataset_version}</td><td>{r.case_id}</td><td><span className={'pill '+r.verdict}>{r.verdict==='accept'?'Αποδεκτή':'Μη αποδεκτή'}</span></td><td>{r.submitted_at.replace('T',' ').slice(0,19)}</td></tr>)}</tbody></table></div></div>{error&&<p className="error">{error}</p>}</>}</div></main>
}
function AdminPassword({auth}:{auth:Auth}){
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [changed,setChanged]=useState(false);

 const submit=async(event:React.FormEvent<HTMLFormElement>)=>{
  event.preventDefault();
  const form=event.currentTarget;
  const fields=new FormData(form);
  const password=fields.get('new_password');
  setChanged(false);
  setError('');
  if(password!==fields.get('confirm_password')){
   setError('Οι κωδικοί δεν ταιριάζουν.');
   return;
  }
  setBusy(true);
  try{
   await api('/admin/password',auth,{
    method:'PUT',
    body:JSON.stringify({current_password:fields.get('current_password'),password}),
   });
   form.reset();
   setChanged(true);
  }catch(error){setError(String(error))}
  finally{setBusy(false)}
 };

 return <section className="card admin-card">
  <div className="heading"><ShieldCheck/><h2>Αλλαγή κωδικού διαχειριστή</h2></div>
  <form onSubmit={submit}>
   <label>Τρέχων κωδικός<input name="current_password" type="password" autoComplete="current-password" required/></label>
   <label>Νέος κωδικός (τουλάχιστον 12 χαρακτήρες)<input name="new_password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required/></label>
   <label>Επιβεβαίωση νέου κωδικού<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required/></label>
   <button className="primary" disabled={busy}>{busy?'Αποθήκευση...':'Αλλαγή κωδικού'}</button>
  </form>
  {error&&<p className="error" role="alert">{error}</p>}
  {changed&&<p className="success" role="status">Ο κωδικός άλλαξε. Οι άλλες συνδέσεις διαχειριστή τερματίστηκαν.</p>}
 </section>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
