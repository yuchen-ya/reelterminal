/** @vitest-environment node */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import type { Action } from "@reelterminal/core/types/actions";
import { workbenchFeedbackId, type ModelObservation, type WorkbenchFeedback } from "@reelterminal/core/types/workbench";
import type { FileResource } from "@reelterminal/core/review/types";
import { remapReviewNodeArchive, validateReviewNodeArchive } from "@reelterminal/core/review/archive";
import { getReviewContext } from "./context";
import { ReviewService } from "./service";
beforeEach(()=>{vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange);});
afterEach(()=>vi.unstubAllGlobals());
const view:ModelObservation={preset:"neutral-r182-v1",background:"dark",camera:{position:[0,0,4],quaternion:[0,0,0,1],target:[0,0,0],fov:40,near:.01,far:100},animation:{index:0,name:"BoneTurn",time:.5},viewport:{width:800,height:600}};
const resource=(id:string,mime:string):FileResource=>({id,mime,size:20,createdAt:1,source:"user",storage:{kind:"blob",blobId:id},originalFileName:mime.startsWith("image")?"observation.png":"model.glb",...(mime.startsWith("image")?{metadata:{type:"image",width:800,height:600,durationSec:0,frameRate:0,codec:"png"}}:{})});

test("model observations upsert/undo atomically, retain attachments through history and require v2 packages",async()=>{
 const service=new ReviewService(),context=await getReviewContext();
 const node=await service.createNode({target:context.target,name:"Models",expectedWorkspaceRevision:0,requestId:crypto.randomUUID()});
 const target={...context.target,nodeId:node.id};const batchId=crypto.randomUUID(),itemId=crypto.randomUUID(),modelId=crypto.randomUUID(),imageA=crypto.randomUUID(),imageB=crypto.randomUUID(),observationId=crypto.randomUUID();
 const commit=(revision:number,build:Parameters<typeof service.commit>[0]["build"],resources:FileResource[]=[])=>service.commit({target,expectedNodeRevision:revision,requestId:crypto.randomUUID(),actor:"human",label:"Model test",request:{revision},build,resources});
 await commit(0,state=>{const built=buildWorkbenchIngestActions(state,{batchId,name:"Models",items:[{id:itemId,title:"Model",type:"model3d",content:{type:"model3d",resourceId:modelId}}]});if(!built.ok)throw new Error(built.message);return built.actions;},[resource(modelId,"model/gltf-binary")]);
 const id=workbenchFeedbackId(itemId,1,`model-${observationId}`);
 const feedback=(image:string):WorkbenchFeedback=>({id,itemId,itemVersion:1,text:"Silhouette",referencedTagIds:[],intent:"rework",state:"confirmed",createdAt:1,updatedAt:2,target:{kind:"model-view",observationId,resourceId:modelId,screenshotResourceId:image,observation:view}});
 const action=(value:WorkbenchFeedback):Action=>({id:crypto.randomUUID(),type:"workbench/feedback.save",timestamp:2,params:{feedback:value}});
 await commit(1,()=>[action(feedback(imageA))],[resource(imageA,"image/png")]);
 await commit(2,()=>[action(feedback(imageB))],[resource(imageB,"image/png")]);
 expect((await service.getItem(target,itemId)).feedback).toHaveLength(1);
 await service.history({target,expectedNodeRevision:3,requestId:crypto.randomUUID(),actor:"human",direction:"undo"});
 expect((await service.getItem(target,itemId)).feedback[0].target).toMatchObject({screenshotResourceId:imageA});
 const archive=await service.archiveNode(target,4);expect(archive.schemaVersion).toBe(2);expect(archive.resources.map(r=>r.id).sort()).toEqual([modelId,imageA,imageB].sort());
 expect(()=>validateReviewNodeArchive({...archive,schemaVersion:1})).toThrow(/schema 2/);
 const restoreId=crypto.randomUUID(),mapped=remapReviewNodeArchive(archive,restoreId);
 const restoredResources=archive.resources.map(original=>({...original,id:mapped.idMap.find(entry=>entry.kind==="resource"&&entry.oldId===original.id)!.newId,storage:{kind:"managed" as const,relativePath:`resources/${original.id}/original.bin`}}));
 const restored=await service.restoreNode({target:context.target,expectedWorkspaceRevision:1,requestId:restoreId,actor:"human",archive,resources:restoredResources});
 const restoredTarget={...context.target,nodeId:restored.node.id};
 expect((await service.archiveNode(restoredTarget,1)).resources.map(r=>r.id).sort()).toEqual(restoredResources.map(r=>r.id).sort());
 await service.directory.commit({target:context.target,expectedWorkspaceRevision:2,requestId:crypto.randomUUID(),actor:"human",commands:[{kind:"node.update",nodeId:restored.node.id,patch:{trashed:true}}]});
 expect((await service.purge.preview(restoredTarget)).resources).toHaveLength(3);
 const bad=feedback(imageA);await expect(commit(4,()=>[action({...bad,target:{...bad.target!,observation:{...view,camera:{...view.camera,near:-1}}} as WorkbenchFeedback["target"]})])).rejects.toBeTruthy();
 expect((await service.getNodeMetadata(target)).revision).toBe(4);
 await expect(commit(4,()=>[action({...bad,target:{...bad.target!,resourceId:crypto.randomUUID()} as WorkbenchFeedback["target"]})])).rejects.toBeTruthy();
 expect((await service.getNodeMetadata(target)).revision).toBe(4);
});

test("a model cannot register an image resource as its GLB original",async()=>{
 const service=new ReviewService(),context=await getReviewContext();
 const node=await service.createNode({target:context.target,name:"Invalid",expectedWorkspaceRevision:0,requestId:crypto.randomUUID()});const target={...context.target,nodeId:node.id},id=crypto.randomUUID();
 await expect(service.commit({target,expectedNodeRevision:0,requestId:crypto.randomUUID(),actor:"agent",label:"Bad",request:{},resources:[resource(id,"image/png")],build:state=>{const built=buildWorkbenchIngestActions(state,{batchId:crypto.randomUUID(),name:"Bad",items:[{id:crypto.randomUUID(),title:"Bad",type:"model3d",content:{type:"model3d",resourceId:id}}]});if(!built.ok)throw new Error(built.message);return built.actions;}})).rejects.toMatchObject({code:"INVALID_PARAMS"});
 expect((await service.listItems(target)).items).toHaveLength(0);
});
