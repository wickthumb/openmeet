// A meet owns its decoded source images. Discard reads from an earlier meet
// before decoding, and share concurrent reads of the same source.
export class SourceImageCache {
  constructor(){this.entries=new Map();this.pending=new Map();this.generation=0;}
  get(key){return this.entries.get(key);}
  clear(){this.generation++;this.entries.clear();this.pending.clear();}
  load(key,read,decode) {
    if(this.entries.has(key))return Promise.resolve(this.entries.get(key));
    if(this.pending.has(key))return this.pending.get(key);
    const generation=this.generation;
    const job=Promise.resolve().then(()=>generation===this.generation?read():null).then(async image=>{
      if(generation!==this.generation)return null;
      const source=await decode(image);
      if(generation!==this.generation)return null;
      if(source!=null)this.entries.set(key,source);
      return source;
    }).finally(()=>{if(this.pending.get(key)===job)this.pending.delete(key);});
    this.pending.set(key,job);return job;
  }
}
