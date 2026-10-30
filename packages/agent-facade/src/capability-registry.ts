/** Static discovery metadata. Execution and parameter contracts stay in the facade. */
import {
  getCommandCatalogEntry,
  type CommandCatalogEntry,
  type CommandCatalogMode,
} from "./command-catalog";
import { EDIT_OP_TYPES, FACADE_VERBS, isReadOnlyVerb, type EditOpType, type FacadeVerb } from "./types";
import { PLUGIN_TOOLS } from "./plugins";
import type { JsonSchemaObject } from "./jsonschema";

export type CapabilityDomain = "video" | "review" | "library" | "system";
export type CapabilityTarget = "video-workspace" | "review-workspace" | "review-node" | "user-library" | "connection" | "local";

export interface CapabilityDefinition {
  readonly id: string;
  readonly domain: CapabilityDomain;
  readonly purpose: string;
  readonly targets: readonly CapabilityTarget[];
  /** Discovery guidance only: this does not grant access or user authorization. */
  readonly activation: "task" | "user-explicit";
  readonly commands: readonly FacadeVerb[];
  readonly operations: readonly EditOpType[];
  readonly workflow: readonly string[];
  readonly legacy?: boolean;
  /** CLI-local tools are deliberately not facade command names. */
  readonly localTools?: readonly string[];
}

interface DefinitionInput extends Omit<CapabilityDefinition, "domain" | "operations" | "activation"> {
  readonly activation?: CapabilityDefinition["activation"];
  readonly operations?: readonly EditOpType[];
}

function capability(input: DefinitionInput): CapabilityDefinition {
  return {
    ...input,
    domain: input.id.split(".")[0] as CapabilityDomain,
    activation: input.activation ?? "task",
    operations: input.operations ?? [],
  };
}

const editCommands = ["edit.validate", "edit.apply"] as const;

export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  capability({
    id: "video.project", purpose: "Discover projects, manage workspaces and save or restore immutable nodes.",
    targets: ["video-workspace"],
    commands: ["project.list", "project.create", "project.open", "project.save", "project.rename", "project.get_state", "project.changes", "workspace.list", "workspace.create", "workspace.delete", "workspace.close", "workspace.switch_view", "workspace.list_drafts", "workspace.recover_draft", "node.list", "node.get", "node.save", "node.restore", "node.rename", "node.media", "node.compare"],
    workflow: ["Resolve an explicit projectId/workspaceId and read its current revision.", "Read the selected command contract; preserve dirty drafts and use its revision/idempotency guards."],
  }),
  capability({
    id: "video.tasks", purpose: "Read user collaboration instructions and requirements; follow asynchronous jobs.",
    targets: ["video-workspace"], commands: ["requirements.list", "requirements.get", "collaboration.instructions.get", "job.status", "job.cancel", ...editCommands],
    operations: ["requirement.update"],
    workflow: ["Read enabled instructions and the relevant requirement before work.", "Poll only jobs owned by the fixed target; update the requirement with a validated edit batch."],
  }),
  capability({
    id: "video.media", purpose: "Inspect, preflight, import and maintain project source media.", targets: ["video-workspace"],
    commands: ["media.import", "media.render_html", "media.references", "media.inspect", "media.import_preflight", "media.production_list", ...editCommands],
    operations: ["media.remove", "media.replace", "media.relink", "media.rename", "media.setProduction"],
    workflow: ["Read allowed media roots before creating or importing files, then inspect/preflight the source.", "Import through media.import; validate and apply version changes to the explicit workspace."],
  }),
  capability({
    id: "video.timeline", purpose: "Read and edit tracks, clips, timing, transforms and markers.", targets: ["video-workspace"],
    commands: ["timeline.get", "timeline.query", "timeline.mapSourceTimes", "editor.get_context", ...editCommands],
    operations: ["track.add", "track.update", "track.remove", "clip.add", "clip.move", "clip.trim", "clip.split", "clip.duplicate", "clip.rippleDelete", "clip.remove", "clip.setSpeed", "clip.setSpeedConfig", "clip.setReverse", "clip.setTransform", "clip.setKeyframes", "clip.applyReframe", "marker.add", "marker.remove"],
    workflow: ["Read a bounded timeline slice and fresh editor context when using selection or playhead.", "Describe the required ops, validate, and apply one atomic batch with target and revision guards."],
  }),
  capability({
    id: "video.graphics", purpose: "Create and edit text and SVG overlays.", targets: ["video-workspace"], commands: [...editCommands],
    operations: ["text.create", "text.update", "text.delete", "svg.create", "svg.update", "svg.remove"],
    workflow: ["Read the affected timeline and overlay state.", "Validate/apply the selected overlay ops, then inspect a rendered frame."],
  }),
  capability({
    id: "video.subtitles", purpose: "Import SRT subtitles or a real transcript into the timeline.", targets: ["video-workspace"], commands: [...editCommands],
    operations: ["subtitle.importSrt", "subtitle.importTranscript"],
    workflow: ["Read the target track and actual subtitle/transcript source.", "Describe the import op, validate and commit the batch; inspect timing and rendered text."],
  }),
  capability({
    id: "video.audio", purpose: "Process source audio and edit clip volume, fades, ducking and analysis-based cuts.", targets: ["video-workspace"],
    commands: ["audio.process.normalize", "audio.process.denoise", "audio.process.separate", "audio.process.register", "job.status", "job.cancel", ...editCommands],
    operations: ["clip.setVolume", "clip.setFade", "clip.setNoiseReduction", "clip.setDucking", "clip.setDuckingFromAnalysis", "clip.cutSilenceFromAnalysis", "clip.splitAtBeat"],
    workflow: ["Probe only the required audio dependency; obtain real analysis records for analysis-based ops.", "For processing, poll completion then register its output; validate/apply timeline changes separately."],
  }),
  capability({
    id: "video.effects", purpose: "Edit transitions, color, chroma key, background removal and video effects.", targets: ["video-workspace"], commands: [...editCommands],
    operations: ["transition.add", "transition.update", "transition.remove", "clip.setColorGrade", "clip.setChromaKey", "clip.setBackgroundRemoval", "clip.addVideoEffect"],
    workflow: ["Read the source clips and describe only the required effects ops.", "Validate/apply one batch and inspect rendered output."],
  }),
  capability({
    id: "video.preview", purpose: "Control the editor and inspect real rendered frames or comparisons.", targets: ["video-workspace"],
    commands: ["editor.get_context", "editor.control", "preview.render_frame", "preview.render_comparison", "visual.inspect", "verify.artifact", "job.status", ...editCommands],
    operations: ["reference.setComparison", "reference.clearComparison"],
    workflow: ["Read current context and probe the rendering provider only when needed.", "Render an explicit range/frame and inspect or verify the resulting artifact; UI controls are transient."],
  }),
  capability({
    id: "video.analysis", purpose: "Run source analysis and read its durable result pages.", targets: ["video-workspace"],
    commands: ["media.analyze_start", "analysis.list", "analysis.get", "batch.start", "batch.get", "batch.resume", "job.status", "job.cancel"],
    workflow: ["Select the real source and requested analysis type; probe its dependencies on demand.", "Start once, follow its owned job, then read analysis.get pages instead of inventing results."],
  }),
  capability({
    id: "video.frames", purpose: "Extract source frames, contact sheets and comparison candidates.", targets: ["video-workspace"],
    commands: ["frames.extract", "frames.contact_sheet", "video.compare"],
    workflow: ["Resolve the exact source media/version and source time semantics.", "Create artifacts under allowed roots and inspect the returned files."],
  }),
  capability({
    id: "video.frame-processing", purpose: "Create alignment, tracking, mask and repair candidates without adopting them.", targets: ["video-workspace"],
    commands: ["image.align", "motion.track", "mask.refine", "patch.apply", "patch.propagate"],
    workflow: ["Read the exact source frames and required region/time contract.", "Run only the requested candidate operation, inspect its result and loss/termination evidence, then adopt separately if requested."],
  }),
  capability({
    id: "video.work-assets", purpose: "Capture, organize and instantiate reusable project work assets.", targets: ["video-workspace"], commands: [...editCommands],
    operations: ["workAsset.capture", "workAsset.rename", "workAsset.delete", "workAsset.instantiate"],
    workflow: ["Read the source work asset or selected project entities.", "Validate/apply the selected workAsset ops in the explicit workspace."],
  }),
  capability({
    id: "video.history", purpose: "Read and control the explicit workspace undo/redo history.", targets: ["video-workspace"], commands: ["history.get", "history.control"],
    workflow: ["Read the target history and current revision.", "Undo or redo with the documented guards, then reread the resulting state."],
  }),
  capability({
    id: "video.export", purpose: "Export a fixed workspace snapshot and verify its delivered artifact.", targets: ["video-workspace"], commands: ["export.start", "job.status", "job.cancel", "verify.artifact"],
    workflow: ["Read the requested export contract and independently probe its provider.", "Start the guarded export, follow the target-owned job, then verify the actual artifact."],
  }),
  capability({
    id: "video.cleanup", purpose: "Review references and execute an exact confirmed cleanup plan.", targets: ["video-workspace"], commands: ["media.references", "media.cleanup.review", "media.cleanup.plan", "media.cleanup.execute"],
    workflow: ["Review retained references and create a scope-bound plan.", "Execute only the reviewed, confirmed plan with its exact target, revision and fingerprints."],
  }),
  capability({
    id: "video.legacy-workbench", purpose: "Maintain existing project-scoped workbench data.", targets: ["video-workspace"], legacy: true,
    commands: ["workbench.ingest", "workbench.get", "workbench.changes", "workbench.handoff.get", ...editCommands],
    operations: ["workbench.decide", "workbench.feedback.save", "workbench.handoff.ack", "workbench.rework", "workbench.content.update"],
    workflow: ["Use only for existing project-scoped workbench content; independent review uses review capabilities.", "Read workbench state and version-bound feedback before applying the required ops."],
  }),
  capability({
    id: "review.tasks", purpose: "Resolve review workspace identity and organize independent task nodes.", targets: ["review-workspace"],
    commands: ["review.context", "review.nodes.list", "review.nodes.create", "review.directory.get", "review.directory.apply", "review.directory.history.control"],
    workflow: ["Read review.context and resolve the intended task explicitly.", "Create a task only for a user-requested independent goal; keep retries, batches and revisions in the original task."],
  }),
  capability({
    id: "review.content", purpose: "Read, ingest and replace real content within one review task.", targets: ["review-node"],
    commands: ["review.get", "review.ingest", "review.items.submit", "review.changes", "review.versions.get"],
    workflow: ["Keep workspace/runtime/node identity fixed; read current state, exact source versions and allowed roots.", "Ingest new content or submit version-bound replacements in the same task, then verify through review.get."],
  }),
  capability({
    id: "review.feedback", purpose: "Read handoffs and edit version-bound feedback, decisions and content.", targets: ["review-node"], commands: ["review.get", "review.apply", "review.handoff.get", "review.versions.get"],
    workflow: ["Read the real handoff and affected item versions.", "Apply guarded feedback or content updates, then reread the task."],
  }),
  capability({
    id: "review.history", purpose: "Read task changes and control its undo/redo history.", targets: ["review-node"], commands: ["review.changes", "review.versions.get", "review.history.control"],
    workflow: ["Read the explicit task's revision and affected versions.", "Apply guarded undo/redo and verify the resulting task."],
  }),
  capability({
    id: "review.steps", purpose: "Record and inspect actual processing steps in a review task.", targets: ["review-node"], commands: ["review.steps.start", "review.steps.complete", "review.steps.fail", "review.steps.list"],
    workflow: ["Start a real step against the explicit task before processing.", "Complete or fail that owned step with real results and inspect the processing record."],
  }),
  capability({
    id: "review.frames", purpose: "Inspect exact task-owned media and extract or capture source video frames.", targets: ["review-node"], commands: ["review.media.inspect", "review.frames.extract", "review.frames.capture"],
    workflow: ["Resolve the exact task-owned source version and decode index/time contract.", "Extract candidates or capture one ordinary image item; capture does not propagate repairs or re-encode video."],
  }),
  capability({
    id: "review.image-repair", purpose: "Inspect and repair an explicit region of a task-owned image version.", targets: ["review-node"], activation: "user-explicit",
    commands: FACADE_VERBS.filter(verb => verb.startsWith("review.repair.")),
    workflow: ["Enter only for an explicit image-repair task; discovery does not authorize image reads or writes.", "Inspect the exact image version and source-pixel region; use the available draft/inspect/commit flow when requested, then verify the committed version."],
  }),
  capability({
    id: "review.export", purpose: "Prepare and copy a review deliverable from the explicit task.", targets: ["review-node"], commands: ["review.export.prepare", "review.export.status", "review.export.cancel", "review.export.copy"],
    workflow: ["Prepare the requested export against the fixed task.", "Follow its owned export job and copy the completed deliverable to the allowed destination."],
  }),
  capability({
    id: "review.backup", purpose: "Inspect and restore review packages.", targets: ["review-workspace"], commands: ["review.package.inspect", "review.package.restore"],
    workflow: ["Inspect the package and requested restore target.", "Restore using its explicit workspace/runtime and revision contract, then verify the restored task."],
  }),
  capability({
    id: "review.attach", purpose: "Attach an explicit review task to a video workspace.", targets: ["review-node", "video-workspace"], commands: ["review.attach"],
    workflow: ["Resolve both the review task identity and destination video workspace.", "Read the attach contract and use both targets' required guards."],
  }),
  capability({
    id: "review.legacy-branches", purpose: "Compare or submit existing historical branches; branch creation is retired.", targets: ["review-node"], legacy: true,
    commands: ["review.branches.create", "review.branches.compare", "review.branches.submit"],
    workflow: ["Use only with existing historical branch data.", "Do not call retired branch creation; continue new work in the original task using content/lineage."],
  }),
  capability({
    id: "library.materials", purpose: "Manage the user material library and attach materials to video workspaces.", targets: ["user-library", "video-workspace"], commands: FACADE_VERBS.filter(verb => verb.startsWith("material.")),
    workflow: ["Read the material and current library version before editing.", "Use the library command contract; attachment additionally requires the explicit video workspace guards."],
  }),
  capability({
    id: "library.fonts", purpose: "List and upload user fonts through the desktop library bridge.", targets: ["user-library"], commands: FACADE_VERBS.filter(verb => verb.startsWith("font.")),
    workflow: ["List existing fonts and inspect the upload contract.", "Upload the requested local font through the available desktop bridge."],
  }),
  capability({
    id: "library.presets", purpose: "Manage user presets and apply them to an explicit video workspace.", targets: ["user-library", "video-workspace"], commands: FACADE_VERBS.filter(verb => verb.startsWith("preset.")),
    workflow: ["Read the preset and library version before editing.", "Apply through the explicit video target and documented revision guards."],
  }),
  capability({
    id: "system.connection", purpose: "Read the facade session contract, access state and scoped runtime dependencies.", targets: ["connection"], commands: ["session.describe", "capabilities.get"],
    workflow: ["Describe the session without changing access settings.", "Probe only the dependency domain needed by the selected task; unprobed does not mean unavailable."],
  }),
  capability({
    id: "system.environment", purpose: "Inspect or prepare the local CLI audio environment on demand.", targets: ["local"], commands: [], localTools: ["environment get", "environment set --file config.json", "environment check", "environment test --file speech.wav --duration 30 [--language auto] [--engine qwen|sensevoice]"],
    workflow: ["Read the current configuration with environment get before replacing it with environment set.", "Run environment check or the bounded real transcription test only when the task needs it; these are CLI-local tools, not facade APIs."],
  }),
  capability({
    id: "system.gui-help", purpose: "Search and read the shipped GUI manual without accessing user content.", targets: ["local"], commands: FACADE_VERBS.filter(verb => verb.startsWith("help.")),
    workflow: ["Search or list shipped manual screens.", "Describe the selected screen for its supported actions and limitations."],
  }),
];

const DOMAIN_PURPOSES: Record<CapabilityDomain, string> = {
  video: "Edit and deliver an explicit project workspace.",
  review: "Work within an explicit independent review task.",
  library: "Manage user materials, fonts and presets.",
  system: "Discover connection state, local environment and GUI help.",
};

export function listCapabilityDomains() {
  return (Object.keys(DOMAIN_PURPOSES) as CapabilityDomain[]).map(id => ({
    id,
    purpose: DOMAIN_PURPOSES[id],
    capabilityCount: CAPABILITY_DEFINITIONS.filter(cap => cap.domain === id && !cap.legacy).length,
  }));
}

export function listCapabilities(options: { domain?: string; capability?: string; includeLegacy?: boolean } = {}): readonly CapabilityDefinition[] {
  if (options.domain && !Object.hasOwn(DOMAIN_PURPOSES, options.domain)) throw new Error(`Unknown capability domain: ${options.domain}`);
  if (options.capability && !CAPABILITY_DEFINITIONS.some(cap => cap.id === options.capability)) throw new Error(`Unknown capability: ${options.capability}`);
  return CAPABILITY_DEFINITIONS.filter(cap =>
    (!options.domain || cap.domain === options.domain)
    && (!options.capability || cap.id === options.capability)
    && (options.includeLegacy || options.capability || !cap.legacy));
}

export interface CommandRegistrationStatus {
  readonly status: "registered" | "retired" | "unsupported";
  readonly availability: "unprobed" | "unavailable";
  readonly reason?: string;
}

function commandStatus(name: FacadeVerb, mode: CommandCatalogMode): CommandRegistrationStatus {
  if (name === "review.branches.create") return { status: "retired", availability: "unavailable", reason: "Task branch creation is retired; continue in the original task." };
  if (name === "project.open" && mode === "live") return { status: "unsupported", availability: "unavailable", reason: "Live project-file opening is owned by the GUI." };
  return { status: "registered", availability: "unprobed" };
}

function commandAuthority(name: FacadeVerb) {
  const plugin = PLUGIN_TOOLS.find(tool => tool.name === name);
  return {
    requiredAccess: isReadOnlyVerb(name) ? "read" as const : "write" as const,
    ...(plugin?.requires ? { dependencies: plugin.requires } : {}),
  };
}

/** A light index: no schemas and no runtime/model/environment probes. */
export function getCapabilityTools(capabilityId: string, options: { mode?: CommandCatalogMode } = {}) {
  const definition = listCapabilities({ capability: capabilityId })[0];
  const mode = options.mode ?? "live";
  return {
    capability: definition,
    tools: definition.commands.map(name => {
      const entry = getCommandCatalogEntry(name, mode)!;
      return {
        name: entry.name,
        toolName: entry.toolName,
        effects: entry.effects,
        retry: entry.retry,
        ...commandAuthority(name),
        ...commandStatus(name, mode),
      };
    }),
    operations: definition.operations,
  };
}

/** Select variants from the already-emitted mode-specific schema, preserving live overrides. */
function selectEditOperations(schema: JsonSchemaObject, operations: readonly string[]): JsonSchemaObject {
  const ops = schema.properties.ops;
  if (!("items" in ops) || !("anyOf" in ops.items)) throw new Error("Edit operation schema is missing its discriminated union");
  const selected = new Set(operations);
  return {
    ...schema,
    properties: {
      ...schema.properties,
      ops: {
        ...ops,
        items: { ...ops.items, anyOf: ops.items.anyOf.filter(variant => {
          const discriminator = variant.properties.op;
          return "const" in discriminator && selected.has(String(discriminator.const));
        }) },
      },
    },
  };
}

/** Full exact command contract by default; --op narrows only the edit union. */
export function describeCommand(name: string, options: { ops?: readonly string[]; mode?: CommandCatalogMode } = {}): CommandCatalogEntry & CommandRegistrationStatus & ReturnType<typeof commandAuthority> {
  const mode = options.mode ?? "live";
  const entry = getCommandCatalogEntry(name, mode);
  if (!entry) throw new Error(`Unknown command: ${name}`);
  if (options.ops !== undefined) {
    if (name !== "edit.apply" && name !== "edit.validate") throw new Error("Operation selection is supported only by edit.apply and edit.validate");
    if (options.ops.length === 0) throw new Error("Select at least one edit operation");
    for (const op of options.ops) if (!(EDIT_OP_TYPES as readonly string[]).includes(op)) throw new Error(`Unknown edit operation: ${op}`);
  }
  return {
    ...entry,
    inputSchema: options.ops ? selectEditOperations(entry.inputSchema, options.ops) : entry.inputSchema,
    ...commandAuthority(entry.name),
    ...commandStatus(entry.name, mode),
  };
}
