/** A pending transition may retain the old version/status or lock its editor. */
export async function withEditorReplacement(page,action){
 const previous=await page.$('.ProseMirror');
 try{
  await action();
  if(previous)await page.waitForFunction(node=>!node.isConnected,{polling:100},previous);
  const mounted=await page.waitForSelector('.ProseMirror');await mounted.dispose();
 }finally{await previous?.dispose();}
}
/** Wait for the requested document's editor, even when its saved version repeats. */
export async function openSelectedSavedDocument(page){
 await withEditorReplacement(page,async()=>{
  await page.waitForFunction(()=>{const button=document.querySelector('.document-list button');return button&&!button.disabled;},{polling:100});
  await page.locator('.document-list button').click();
  await page.waitForSelector('.document-library',{hidden:true});
 });
}
