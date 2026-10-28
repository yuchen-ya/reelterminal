import { expect, test, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ModelObservation, WorkbenchFeedback, WorkbenchHandoff, WorkbenchItem } from "@reelterminal/core/types/workbench";
import type { ReviewContext, ReviewNode, ReviewStep } from "@reelterminal/core/review/types";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import { inspectGlb } from "@reelterminal/core/review/glb";
import { modelFixture, encodeGlb } from "../../../packages/core/src/review/glb-fixtures.test-helper";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";
import { evidenceJsonReplacer } from "./harness/evidence";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("GLB real renderer: material/skin/morph, frozen feedback, rework, comparison, original export and package restore", async () => {
  let launched = await launchApp(); await launched.waitForEndpointFile();
  let agent = await connectExternalAgent(launched.endpointFile);
  const evidence: Record<string, unknown> = { fixtureLicense:"Original programmatic fixtures, repository MIT", measuredAt:new Date().toISOString() };
  try {
    let page = launched.page;
    const network: string[] = [];
    page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("GLB acceptance");
    await page.getByTestId("review-create-node").click(); await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    let context = value(await agent.callCommand<ReviewContext>("review.context"));
    const node = value(await agent.callCommand<{nodes:ReviewNode[]}>("review.nodes.list", {target:context.target})).nodes[0];
    let target = {...context.target,nodeId:node.id};
    const fixture = modelFixture(), nextFixture = modelFixture({color:[.8,.1,.2,1]});
    const source = path.join(launched.runDir,"original.glb"), nextFile = path.join(launched.runDir,"reworked.glb");
    await writeFile(source, fixture.bytes); await writeFile(nextFile, nextFixture.bytes);
    // Formal GUI file import, including the native resource preparation path.
    await page.getByTestId("review-node-editor").getByRole("button",{name:/Import content|导入内容/}).first().click();
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page.getByTestId("review-import-submit").click();
    const preview = () => page.getByTestId("model-preview").first();
    const ready = async () => vi.waitFor(async () => expect(await preview().getAttribute("data-phase")).toBe("ready"),{timeout:20000});
    await ready();
    const entries = value(await agent.callCommand<{items: WorkbenchItem[]}>("review.get",{target}));
    const itemId=entries.items[0].id;
    const readItem = async () => value(await agent.callCommand<{item: WorkbenchItem;feedback:WorkbenchFeedback[]}>("review.get",{target,itemId}));
    const nodeRevision = async () => value(await agent.callCommand<{node:ReviewNode}>("review.get",{target})).node.revision;
    const original = (await readItem()).item; expect(original.type).toBe("model3d");
    if(original.content.type!=="model3d") throw new Error("Missing model");
    const originalResource=original.content.resourceId;
    const observation = async () => JSON.parse((await preview().getAttribute("data-observation"))!) as ModelObservation;
    const initial = await observation(); expect(initial.animation?.time).toBe(0);
    const renderCount = await page.getByTestId("model-canvas-host").getAttribute("data-render-count");
    await page.waitForTimeout(200); expect(await page.getByTestId("model-canvas-host").getAttribute("data-render-count")).toBe(renderCount);
    const beforeRevision = await nodeRevision();
    const host = page.getByTestId("model-canvas-host"); const box=(await host.boundingBox())!;
    await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5); await page.mouse.down(); await page.mouse.move(box.x+box.width*.65,box.y+box.height*.55,{steps:10}); await page.mouse.up();
    expect((await observation()).camera.position).not.toEqual(initial.camera.position);
    await page.mouse.wheel(0,-180); await page.waitForTimeout(100);
    await page.getByLabel("标准视角").selectOption("front");
    await page.getByLabel("模型背景").selectOption("light");
    await page.getByTestId("model-play").click(); await page.waitForTimeout(350); await page.getByTestId("model-play").click();
    expect((await observation()).animation!.time).toBeGreaterThan(.1);
    const seek = async (fraction: number) => { const range=page.getByLabel("动画时间"); const r=(await range.boundingBox())!; await page.mouse.click(r.x+r.width*fraction,r.y+r.height/2); };
    await seek(.45); const boneView=await observation(); expect(boneView.animation!.time).toBeGreaterThan(.7);
    await mkdir(ARTIFACTS_DIR,{recursive:true}); await page.screenshot({path:path.join(ARTIFACTS_DIR,"review-model3d-bone.png")});
    await page.getByLabel("模型动画").selectOption("1"); await seek(.5);
    const morphView=await observation(); expect(morphView.animation!.name).toBe("MorphRise");
    await page.screenshot({path:path.join(ARTIFACTS_DIR,"review-model3d-morph.png")});
    expect(await nodeRevision()).toBe(beforeRevision); // observation is not content revision/history
    const pixels = await page.locator('canvas[aria-label="3D model preview"]').evaluate(canvas => {
      const gl=(canvas as HTMLCanvasElement).getContext("webgl2")!;
      // Capture rendered pixels immediately on next native viewer snapshot; GPU info is independently queried here.
      const debug=gl.getExtension("WEBGL_debug_renderer_info");
      return {renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),vendor:gl.getParameter(gl.VENDOR),width:(canvas as HTMLCanvasElement).width,height:(canvas as HTMLCanvasElement).height};
    });
    evidence.gpu=pixels; evidence.initial=initial;evidence.bone=boneView;evidence.morph=morphView;
    await page.getByTestId("model-capture").click();
    await page.getByLabel("模型观察备注").fill("Inspect morph silhouette at this exact pose");
    await page.getByRole("checkbox",{name:"标记返工",exact:true}).check();
    await page.getByTestId("model-save-feedback").click();
    await vi.waitFor(async()=>expect((await readItem()).feedback.length).toBe(1)); await ready();
    let saved=(await readItem()).feedback[0]; expect(saved.target?.kind).toBe("model-view");
    if(saved.target?.kind!=="model-view") throw new Error("Missing observation");
    expect(saved.target.observation).toEqual(morphView); expect(saved.itemVersion).toBe(1);
    const screenshot = await page.evaluate(async id=>window.reelterminal!.reviewFiles!.resolve(id,true),saved.target.screenshotResourceId);
    if(!screenshot.ok) throw new Error(screenshot.error.message);
    const screenshotBytes=await readFile(screenshot.value.path);expect(screenshotBytes.subarray(1,4).toString()).toBe("PNG");
    await page.getByTestId("model-saved-observation").click(); await ready();
    expect((await observation()).animation!.time).toBeCloseTo(morphView.animation!.time,3);
    await page.getByRole("button",{name:"返回当前版本"}).click();await ready();
    await page.getByTestId("model-capture").click();await page.getByTestId("model-save-feedback").click();
    await vi.waitFor(async()=>expect((await readItem()).feedback.length).toBe(1));await ready();
    saved=(await readItem()).feedback[0];
    await page.getByRole("button",{name:/发布审阅结果/}).click();
    await page.getByRole("button",{name:/发布交接结果|更新交接结果/}).click();
    await page.getByText(/等待 Agent 读取/).first().waitFor();await page.keyboard.press("Escape");
    const changes=value(await agent.callCommand<{entries:Array<{handoffIds?:string[]}>}>("review.changes",{target,afterSequence:0}));
    const handoffId=changes.entries.flatMap(entry=>entry.handoffIds??[]).at(-1)!;
    const handoff=value(await agent.callCommand<{handoff:WorkbenchHandoff}>("review.handoff.get",{target,handoffId})).handoff;
    expect(handoff.items[0].resourceId).toBe(originalResource);expect(handoff.items[0].issues![0].target).toEqual((await readItem()).feedback[0].target);
    const apply=async(ops:unknown[])=>value(await agent.callCommand("review.apply",{target,expectedNodeRevision:await nodeRevision(),requestId:crypto.randomUUID(),ops}));
    await apply([{op:"workbench.handoff.ack",handoffId}]);
    const stepId=crypto.randomUUID(), nextResource=crypto.randomUUID();
    value(await agent.callCommand("review.steps.start",{target,expectedNodeRevision:await nodeRevision(),requestId:crypto.randomUUID(),stepId,runId:crypto.randomUUID(),label:"Change fixture material",inputs:[{nodeId:node.id,itemId,version:1,role:"source"}],method:{kind:"algorithm",name:"MIT fixture generator"}}));
    value(await agent.callCommand("review.steps.complete",{target,expectedNodeRevision:await nodeRevision(),requestId:crypto.randomUUID(),stepId,
      files:[{resourceId:nextResource,sourcePath:nextFile,mime:"model/gltf-binary"}],ops:[{op:"workbench.rework",handoffId,results:[{sourceItemId:itemId,previousVersion:1,content:{type:"model3d",resourceId:nextResource}}]}],outputs:[{nodeId:node.id,itemId,version:2,role:"result"}]}));
    await ready(); expect((await readItem()).item.version).toBe(2);expect((await readItem()).feedback[0].itemVersion).toBe(1);
    expect((await observation()).animation?.time).toBe(0);
    await page.getByTestId("review-process-tab").click();
    await page.getByTestId("review-step-card").filter({hasText:"Change fixture material"}).getByTestId("review-step-compare").click();
    await vi.waitFor(async()=>expect(await page.locator('[data-testid="model-preview"][data-phase="ready"]').count()).toBe(2),{timeout:20000});
    await page.getByLabel("模型相机联动").selectOption("direction");
    await page.getByLabel("标准视角").first().selectOption("right");
    const cameras=await page.getByTestId("model-preview").evaluateAll(elements=>elements.map(e=>JSON.parse(e.getAttribute("data-observation")!).camera));
    cameras[0].quaternion.forEach((value:number,index:number)=>expect(value).toBeCloseTo(cameras[1].quaternion[index],10));
    await page.screenshot({path:path.join(ARTIFACTS_DIR,"review-model3d-comparison.png")});
    await page.getByTestId("review-content-tab").click();await ready();
    await page.getByTestId("workbench-bottom-dock").getByRole("button",{name:"保留",exact:true}).click();
    await vi.waitFor(async()=>expect((await readItem()).item.status).toBe("kept"),{timeout:15000});
    const exportTo = async(mode:"original"|"adopted"|"node-package")=>{
      const exportId=crypto.randomUUID();value(await agent.callCommand("review.export.prepare",{target,expectedNodeRevision:await nodeRevision(),exportId,scope:"node",mode}));
      let status:ReviewExportStatus;await vi.waitFor(async()=>{status=value(await agent.callCommand<ReviewExportStatus>("review.export.status",{target,exportId}));expect(status.state,JSON.stringify(status.error)).toBe("ready");},{timeout:20000});
      const directory=path.join(launched.runDir,`export-${mode}`);await mkdir(directory);const copied=value(await agent.callCommand<{directory:string}>("review.export.copy",{target,exportId,directory}));
      return {status:status!,directory:copied.directory};
    };
    const exported=await exportTo("original"),adopted=await exportTo("adopted"),pack=await exportTo("node-package");
    expect(hash(await readFile(path.join(exported.directory,exported.status.manifest!.entries[0].relativePath)))).toBe(hash(fixture.bytes));
    expect(hash(await readFile(path.join(adopted.directory,adopted.status.manifest!.entries[0].relativePath)))).toBe(hash(nextFixture.bytes));
    const archive=JSON.parse(await readFile(path.join(pack.directory,"node.json"),"utf8"));expect(archive.schemaVersion).toBe(2);expect(archive.resources.some((r:{id:string})=>r.id===saved.target!.screenshotResourceId)).toBe(true);
    evidence.handoff=handoff;evidence.exports={original:exported.status,adopted:adopted.status,package:pack.status};
    await agent.close();launched=await launched.relaunch();agent=await connectExternalAgent(launched.endpointFile);page=launched.page;
    await page.getByTestId("model-workspace").waitFor({timeout:20000});await ready();
    context=value(await agent.callCommand<ReviewContext>("review.context"));target={...context.target,nodeId:node.id};
    expect((await readItem()).item.content).toEqual({type:"model3d",resourceId:nextResource});
    await page.getByTestId("model-saved-observation").click();await ready();expect(await preview().getAttribute("data-resource-id")).toBe(originalResource);
    expect((await observation()).animation!.time).toBeCloseTo((saved.target as Extract<WorkbenchFeedback["target"],{kind:"model-view"}>).observation.animation!.time,3);
    await page.getByTestId("review-access-toggle").click();
    const inspected=value(await agent.callCommand<{packageId:string;digest:string}>("review.package.inspect",{target:context.target,directory:pack.directory}));
    const dir=value(await agent.callCommand<{revision:number}>("review.directory.get",{target:context.target}));
    const restored=value(await agent.callCommand<{node:ReviewNode}>("review.package.restore",{target:context.target,expectedWorkspaceRevision:dir.revision,requestId:crypto.randomUUID(),packageId:inspected.packageId,digest:inspected.digest}));
    const restoredTarget={...context.target,nodeId:restored.node.id};const restoredList=value(await agent.callCommand<{items:WorkbenchItem[]}>("review.get",{target:restoredTarget}));
    const restoredItem=value(await agent.callCommand<{item:WorkbenchItem;feedback:WorkbenchFeedback[]}>("review.get",{target:restoredTarget,itemId:restoredList.items[0].id}));
    expect(restoredItem.item.content.type).toBe("model3d");expect(restoredItem.feedback[0].target).not.toEqual(saved.target);
    if(restoredItem.feedback[0].target?.kind!=="model-view")throw new Error("Restored observation missing");
    expect(restoredItem.feedback[0].target.observation).toEqual((await readItem()).feedback[0].target!.observation);
    await page.getByTestId("review-node-list").getByRole("button").filter({hasText:"GLB acceptance"}).first().click();
    await vi.waitFor(async()=>expect(await page.getByTestId("review-node-title").getAttribute("data-node-id")).toBe(restored.node.id));
    await ready();await page.getByTestId("model-saved-observation").click();await ready();
    expect(await preview().getAttribute("data-resource-id")).toBe(restoredItem.feedback[0].target.resourceId);
    const restoredScreenshot=await page.evaluate(id=>window.reelterminal!.reviewFiles!.resolve(id,true),restoredItem.feedback[0].target.screenshotResourceId);
    if(!restoredScreenshot.ok)throw new Error(restoredScreenshot.error.message);
    expect((await readFile(restoredScreenshot.value.path)).subarray(1,4).toString()).toBe("PNG");
    const restoredExportId=crypto.randomUUID();
    value(await agent.callCommand("review.export.prepare",{target:restoredTarget,expectedNodeRevision:1,exportId:restoredExportId,scope:"node",mode:"node-package"}));
    let restoredExport:ReviewExportStatus;await vi.waitFor(async()=>{restoredExport=value(await agent.callCommand<ReviewExportStatus>("review.export.status",{target:restoredTarget,exportId:restoredExportId}));expect(restoredExport.state).toBe("ready");});
    expect(restoredExport!.manifest!.entries).toHaveLength(pack.status.manifest!.entries.length);
    evidence.restoredExport=restoredExport!;
    evidence.restored=restoredItem;evidence.network=network;expect(network).toEqual([]);
    evidence.console=launched.output.rendererConsole;expect(launched.output.rendererConsole.filter(line=>/pageerror|\[error\]/i.test(line))).toEqual([]);
    await writeFile(path.join(ARTIFACTS_DIR,"review-model3d.json"),JSON.stringify(evidence,evidenceJsonReplacer,2));
  } finally {
    await mkdir(ARTIFACTS_DIR,{recursive:true});
    if(!launched.page.isClosed())await launched.page.screenshot({path:path.join(ARTIFACTS_DIR,"review-model3d-terminal.png")});
    await writeFile(path.join(ARTIFACTS_DIR,"review-model3d-console.json"),JSON.stringify(launched.output.rendererConsole,evidenceJsonReplacer,2));
    await agent.close();await launched.close();
  }
},180000);


test("GLB bounded native samples, rejected previews retain bytes, race/context lifecycle and dual-view measurements",async()=>{
 const launched=await launchApp();await launched.waitForEndpointFile();const agent=await connectExternalAgent(launched.endpointFile);const page=launched.page;
 const evidence:Record<string,unknown>={measuredAt:new Date().toISOString()};
 const network:string[]=[];page.on("request",request=>{if(/^https?:/.test(request.url()))network.push(request.url());});
 try {
  await page.getByRole("tab",{name:/Review Workspace|审阅工作台/i}).click();await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("GLB budgets");await page.getByTestId("review-create-node").click();await page.getByTestId("review-node-title").waitFor();await page.getByTestId("review-access-toggle").click();
  const context=value(await agent.callCommand<ReviewContext>("review.context"));const node=value(await agent.callCommand<{nodes:ReviewNode[]}>("review.nodes.list",{target:context.target})).nodes[0];const target={...context.target,nodeId:node.id};
  const base=modelFixture({animated:false});
  const fixtures=[{name:"Static PBR alpha",bytes:base.bytes},{name:"Animated",bytes:modelFixture().bytes},
   {name:"External URI",bytes:encodeGlb({...base.doc,images:[{uri:"https://example.invalid/never-request.png"}]},base.binary)},
   {name:"Unknown required",bytes:encodeGlb({...base.doc,extensionsRequired:["NOT_SUPPORTED"]},base.binary)},
   {name:"Empty",bytes:encodeGlb({asset:{version:"2.0"},scenes:[{nodes:[]}]})},
   {name:"Expanded budget",bytes:encodeGlb({...base.doc,accessors:[{type:"VEC3",count:100000000,componentType:5126}]},base.binary)}];
  const batchId=crypto.randomUUID();const files=[],items=[];
  for(const fixture of fixtures){const file=path.join(launched.runDir,fixture.name+".glb");await writeFile(file,fixture.bytes);const resourceId=crypto.randomUUID();files.push({resourceId,sourcePath:file,mime:"model/gltf-binary"});items.push({id:crypto.randomUUID(),title:fixture.name,type:"model3d",content:{type:"model3d",resourceId}});}
  value(await agent.callCommand("review.ingest",{target,expectedNodeRevision:0,requestId:crypto.randomUUID(),batchId,name:"GLB sample validation",files,items}));
  const select=async(name:string)=>page.getByTestId("workbench-tree-panel").getByText(name,{exact:true}).click();
  const ready=async()=>vi.waitFor(async()=>expect(await page.getByTestId("model-preview").getAttribute("data-phase")).toBe("ready"),{timeout:30000});
  await page.context().setOffline(true);
  await select("Static PBR alpha");await ready();expect(await page.getByTestId("model-play").count()).toBe(0);
  const baseline=await page.getByTestId("model-canvas-host").evaluate(e=>({geometries:Number((e as HTMLElement).dataset.geometries),textures:Number((e as HTMLElement).dataset.textures)}));
  await page.screenshot({path:path.join(ARTIFACTS_DIR,"review-model3d-static.png")});
  for(const fixture of fixtures.slice(2)){
   await select(fixture.name);await vi.waitFor(async()=>expect(await page.getByTestId("model-preview").getAttribute("data-phase")).toBe("error"));
   const resourceId=items.find(item=>item.title===fixture.name)!.content.resourceId;const original=await page.evaluate(id=>window.reelterminal!.reviewFiles!.resolve(id,true),resourceId);if(!original.ok)throw new Error(original.error.message);expect((await readFile(original.value.path)).equals(fixture.bytes)).toBe(true);
  }
  const exportId=crypto.randomUUID();value(await agent.callCommand("review.export.prepare",{target,expectedNodeRevision:1,exportId,scope:"node",mode:"original"}));
  let exported:ReviewExportStatus;await vi.waitFor(async()=>{exported=value(await agent.callCommand<ReviewExportStatus>("review.export.status",{target,exportId}));expect(exported.state).toBe("ready");});
  const destination=path.join(launched.runDir,"rejected-originals");await mkdir(destination);const copied=value(await agent.callCommand<{directory:string}>("review.export.copy",{target,exportId,directory:destination}));
  for(const entry of exported!.manifest!.entries){const fixture=fixtures[items.findIndex(item=>item.content.resourceId===entry.resourceId)];expect((await readFile(path.join(copied.directory,entry.relativePath))).equals(fixture.bytes)).toBe(true);}
  const cycles=[];
  for(let i=0;i<6;i++){
   await select("Animated");await select("Static PBR alpha");await ready();expect(await page.getByTestId("model-preview").getAttribute("data-resource-id")).toBe(items[0].content.resourceId);
   const resources=await page.getByTestId("model-canvas-host").evaluate(e=>({geometries:Number((e as HTMLElement).dataset.geometries),textures:Number((e as HTMLElement).dataset.textures)}));expect(resources).toEqual(baseline);cycles.push(resources);
  }
  await page.locator('canvas[aria-label="3D model preview"]').evaluate(canvas=>(canvas as HTMLCanvasElement).getContext("webgl2")!.getExtension("WEBGL_lose_context")!.loseContext());
  await vi.waitFor(async()=>expect(await page.getByTestId("model-preview").getAttribute("data-phase")).toBe("context-lost"));await page.getByRole("button",{name:"重载预览"}).click();await ready();
  await select("Animated");await ready();await page.getByTestId("model-play").click();
  const host=page.getByTestId("model-canvas-host");await host.evaluate(e=>{(e as HTMLElement).style.visibility="hidden";(e as HTMLElement).style.display="none";});await page.waitForTimeout(100);
  let stopped:string|null=null;await vi.waitFor(async()=>{stopped=await host.getAttribute("data-render-count");await page.waitForTimeout(200);expect(await host.getAttribute("data-render-count")).toBe(stopped);},{timeout:5000});
  await host.evaluate(e=>{(e as HTMLElement).style.visibility="";(e as HTMLElement).style.display="";});await page.waitForTimeout(100);expect(Number(await host.getAttribute("data-render-count"))).toBeGreaterThan(Number(stopped));
  await page.getByRole("tab",{name:/Video edit|视频编辑/i}).click();expect(await page.locator('canvas[aria-label="3D model preview"]').count()).toBe(0);await page.getByRole("tab",{name:/Review Workspace|审阅工作台/i}).click();await ready();
  const stress=modelFixture({animated:false,triangles:160000,textureSide:4096});
  const stressPath=path.join(launched.runDir,"stress.glb");await writeFile(stressPath,stress.bytes);
  const left=crypto.randomUUID(),right=crypto.randomUUID(),stressItem=crypto.randomUUID(),step=crypto.randomUUID();const now=Date.now();
  const current=value(await agent.callCommand<{node:ReviewNode}>("review.get",{target}));
  const started=performance.now();
  value(await agent.callCommand("review.ingest",{target,expectedNodeRevision:current.node.revision,requestId:crypto.randomUUID(),batchId:crypto.randomUUID(),name:"Measured dual-view budget",
   files:[{resourceId:left,sourcePath:stressPath,mime:"model/gltf-binary"},{resourceId:right,sourcePath:stressPath,mime:"model/gltf-binary"}],items:[{id:stressItem,title:"Stress model",type:"model3d",content:{type:"model3d",resourceId:right}}],
   steps:[{id:step,runId:crypto.randomUUID(),label:"Stress pair",inputs:[{resourceId:left,role:"source"}],outputs:[{nodeId:node.id,itemId:stressItem,version:1,role:"result"}],method:{kind:"algorithm",name:"MIT repeated triangle fixture"},startedAt:now,finishedAt:now}]}));
  await page.getByTestId("review-process-tab").click();await page.getByTestId("review-step-card").filter({hasText:"Stress pair"}).getByTestId("review-step-compare").click();
  await vi.waitFor(async()=>expect(await page.locator('[data-testid="model-preview"][data-phase="ready"]').count()).toBe(2),{timeout:30000});
  const dualLoadMs=performance.now()-started;
  const stats=await page.getByTestId("model-canvas-host").evaluateAll(elements=>elements.map(e=>({geometries:Number((e as HTMLElement).dataset.geometries),textures:Number((e as HTMLElement).dataset.textures),renders:Number((e as HTMLElement).dataset.renderCount)})));
  const memory=await launched.app.evaluate(({app})=>app.getAppMetrics().map(({type,memory})=>({type,memory})));
  await page.screenshot({path:path.join(ARTIFACTS_DIR,"review-model3d-budget-pair.png")});
  evidence.gpu=await launched.app.evaluate(({app})=>app.getGPUInfo("basic"));evidence.network=network;evidence.offline=true;expect(network).toEqual([]);
  evidence.samples=fixtures.map(f=>({name:f.name,bytes:f.bytes.length}));evidence.cycles=cycles;evidence.stress={preflight:inspectGlb(stress.bytes.buffer.slice(stress.bytes.byteOffset,stress.bytes.byteOffset+stress.bytes.byteLength) as ArrayBuffer),fileBytes:stress.bytes.length,textureSide:4096,texturePixels:4096**2,triangles:480000,dualLoadMs,stats,memory};
  evidence.console=launched.output.rendererConsole;await writeFile(path.join(ARTIFACTS_DIR,"review-model3d-budget.json"),JSON.stringify(evidence,evidenceJsonReplacer,2));
 }finally{await writeFile(path.join(ARTIFACTS_DIR,"review-model3d-budget-console.json"),JSON.stringify(launched.output.rendererConsole,evidenceJsonReplacer,2));if(!page.isClosed())await page.screenshot({path:path.join(ARTIFACTS_DIR,"review-model3d-budget-terminal.png"),timeout:60000});await agent.close();await launched.close();}
},180000);
