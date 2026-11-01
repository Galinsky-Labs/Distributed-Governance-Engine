import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicDraftCache} from '../editor/draft-cache.mjs';
import {createLegalDocument} from '../src/legal-structure.mjs';
test('tampered local public-cache timestamp fails closed',()=>{
 const items=new Map();
 const storage={setItem:(key,value)=>items.set(key,value),getItem:key=>items.get(key)??null,removeItem:key=>items.delete(key)};
 const cache=createPublicDraftCache(storage,{namespace:'test',classification:'public'});
 const document=createLegalDocument({id:'doc-1',tenantId:'tenant-1',title:'Draft'});
 assert.equal(cache.save(document).state,'saved');
 assert.equal(cache.load({tenantId:'tenant-1',id:'doc-1'}).state,'available');
 const [key,value]=[...items][0];
 const row=JSON.parse(value);row.savedAt='<img src=x onerror=alert(1)>';items.set(key,JSON.stringify(row));
 assert.equal(cache.load({tenantId:'tenant-1',id:'doc-1'}).state,'corrupt');
});
