/** Wait for the requested document's editor, even when its saved version repeats. */
export async function openSelectedSavedDocument(page){
 const previous=await page.$('.ProseMirror');
 try{
  await page.waitForFunction(()=>{const button=document.querySelector('.document-list button');return button&&!button.disabled;},{polling:100});
  await page.click('.document-list button');
  await page.waitForSelector('.document-library',{hidden:true});
  if(previous)await page.waitForFunction(node=>!node.isConnected,{polling:100},previous);
  const mounted=await page.waitForSelector('.ProseMirror');await mounted.dispose();
 }finally{await previous?.dispose();}
}
