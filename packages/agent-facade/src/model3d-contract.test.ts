import { expect, test } from "vitest";
import { REVIEW_SCHEMAS } from "./review";
import { validateObject } from "./validate";
import { EMITTED_VERB_JSON_SCHEMAS } from "./jsonschema";

test("model3d is a closed review content input using a FileResource UUID",()=>{
 const resourceId=crypto.randomUUID(),input={target:{kind:"review",reviewWorkspaceId:crypto.randomUUID(),nodeId:crypto.randomUUID(),instanceId:crypto.randomUUID()},expectedNodeRevision:0,requestId:crypto.randomUUID(),batchId:crypto.randomUUID(),name:"GLB",items:[{id:crypto.randomUUID(),title:"GLB",type:"model3d",content:{type:"model3d",resourceId}}]};
 expect(()=>validateObject(input,REVIEW_SCHEMAS["review.ingest"],"params")).not.toThrow();
 for(const content of [{type:"model3d",resourceId:"not-a-uuid"},{type:"model3d",mediaId:resourceId},{type:"model3d",resourceId,meshId:"invented-anchor"}])expect(()=>validateObject({...input,items:[{...input.items[0],content}]},REVIEW_SCHEMAS["review.ingest"],"params")).toThrow();
 expect(JSON.stringify(EMITTED_VERB_JSON_SCHEMAS["review.ingest"])).toContain('"model3d"');
 expect(JSON.stringify(EMITTED_VERB_JSON_SCHEMAS["review.apply"])).toContain('"model-view"');
});
