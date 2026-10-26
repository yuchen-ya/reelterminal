[CmdletBinding()]
param(
  [ValidateSet('DryRun', 'Apply', 'RepairOwnerEvidence')]
  [string]$Mode = 'DryRun',
  [string]$Root = 'E:\1Data\reelterminal\agent-workspace\jobs'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedRoot = [System.IO.Path]::GetFullPath('E:\1Data\reelterminal\agent-workspace\jobs').TrimEnd('\')
$rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
if (-not [string]::Equals($rootPath, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "This usage index is limited to $expectedRoot"
}
if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
  throw "Legacy jobs root does not exist: $rootPath"
}

$indexJobName = '2026-10-25-legacy-job-usage-index'
$indexJobPath = [System.IO.Path]::GetFullPath((Join-Path $rootPath $indexJobName))
if (-not $indexJobPath.StartsWith(($rootPath + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Index job path escaped the authorized jobs root.'
}
if ($Mode -eq 'Apply' -and (Test-Path -LiteralPath $indexJobPath)) {
  throw "Refusing to overwrite an existing usage index: $indexJobPath"
}
if ($Mode -eq 'RepairOwnerEvidence') {
  $existingSummaryPath = Join-Path $indexJobPath 'project\usage-index-summary.json'
  if (-not (Test-Path -LiteralPath $existingSummaryPath -PathType Leaf)) {
    throw "Owner-evidence repair requires the existing usage index: $indexJobPath"
  }
  $existingSummary = Get-Content -LiteralPath $existingSummaryPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  if ($existingSummary.format -ne 'reelterminal-legacy-job-usage-index/v1' -or $existingSummary.indexJobPath -ne $indexJobPath -or $existingSummary.ownedFiles.Count -notin @(8, 10)) {
    throw 'Existing usage-index marker or rollback ownership boundary does not match this repair.'
  }
}

$migrationId = [System.Guid]::NewGuid().ToString()
$outputDecisions = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
$sourceDecisions = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
function Add-OutputDecision {
  param([string]$Job, [string]$RelativePath, [string]$Purpose, [string]$Status, [string[]]$Evidence, [string]$Reason)
  $key = "$Job\$RelativePath"
  $outputDecisions[$key] = [pscustomobject]@{
    purpose = $Purpose
    deliveryStatus = $Status
    evidence = $Evidence
    reason = $Reason
  }
}

# The one-file music job has no local brief. Two later album manifests directly
# reference this exact original path as input, which is sufficient to classify
# its use as source while leaving the owning project/workspace unknown.
$sourceDecisions['2026-10-10-memory-album\music\nostalgic_piano_bgm.mp3'] = [pscustomobject]@{
  purpose = 'Music input explicitly referenced by two later memory-album job manifests.'
  confidence = 'high'
  evidence = @(
    'E:\1Data\reelterminal\agent-workspace\jobs\2026-10-11-memory-album-review\project\manifest.json',
    'E:\1Data\reelterminal\agent-workspace\jobs\2026-10-11-memory-album-cinematic\project\manifest.json'
  )
  reason = 'Both later manifests contain this exact absolute path in their media-source references; no project owner is borrowed from those consumers.'
}

# These are exact files supported by job briefs or completion/delivery records.
# Other files in output/ and delivery/ are treated as work unless their own
# contextual evidence is added here after review.
Add-OutputDecision '2026-09-18-pelican-bonsai' 'output\bonsai2-showcase.mp4' 'Verified final showcase export' 'delivered' @('project\manifest.json') 'manifest.finalFile and verify_artifact pass identify the completed 17-second showcase.'
Add-OutputDecision '2026-10-05-readme-showcase' 'output\desktop-screenshot.jpg' 'README desktop screenshot deliverable' 'pending' @('brief.md', 'project\manifest.json') 'The brief requests this screenshot and the manifest names it as the repository asset; the destination asset is absent in this checkout.'
Add-OutputDecision '2026-10-06-promo-video' 'output\promo-v8-definitive.mp4' 'Verified V8 final promo export' 'delivered' @('brief.md', 'project\director-handoff-v8.md') 'The V8 handoff names this final file and documents verification; V6/V7 and review variants are historical work.'
Add-OutputDecision '2026-10-09-user-workflow-a' 'output\一路相伴-时光相册-20s.mp4' 'Verified final A acceptance export' 'delivered' @('brief.md', 'project\manifest.json') 'The final manifest records this file and verifyArtifactPass=true.'
Add-OutputDecision '2026-10-09-user-workflow-b' 'output\B-流动时光-v2.mp4' 'Verified final B acceptance export' 'delivered' @('brief.md', 'project\manifest.json') 'The final manifest records this file and a passing export verification.'
Add-OutputDecision '2026-10-12-viewer-continuity' 'output\ReelTerminal-full-revised.mp4' 'Verified full-timeline export' 'delivered' @('brief.md', 'project\manifest.json') 'The manifest names the revision-189 export and the brief records final export and pixel comparison passing.'
Add-OutputDecision '2026-10-12-final-narration' 'output\final-voiceover.wav' 'Final aligned narration audio asset' 'delivered' @('brief.md', 'project\manifest.json') 'The task requests a new complete voice track, the file is named final-voiceover.wav, and the brief says to import/commit the voice on the existing timeline; only full-video export is explicitly out of scope.'
Add-OutputDecision '2026-10-14-audio-subtitle-align' 'output\宣传片-音频字幕对齐.mp4' 'Verified aligned-video export' 'delivered' @('brief.md', 'project\manifest.json') 'The final manifest records the verified video export.'
Add-OutputDecision '2026-10-14-audio-subtitle-align' 'output\宣传片-对齐字幕.srt' 'Final aligned subtitle sidecar' 'delivered' @('brief.md', 'project\manifest.json') 'The final manifest names this subtitle sidecar for the verified aligned export.'
Add-OutputDecision '2026-10-15-live-edit' 'output\ReelTerminal-polished-r343.mp4' 'Verified polished full-video export' 'delivered' @('brief.md', 'project\manifest.json') 'The revision-343 manifest records the export and verificationPass=true.'
Add-OutputDecision '2026-10-16-requiem-realistic-dance' 'output\安魂曲_写实舞蹈完整版_模型超分.mp4' 'Verified final dance export' 'delivered' @('brief.md', 'project\manifest.json') 'The brief explicitly identifies the completed final deliverable and records format, frame, and decode checks.'
Add-OutputDecision '2026-10-22-selene-attack-animation' 'output\attack\attack-action-107f-24fps-transparent.webm' 'Transparent attack animation art candidate' 'pending' @('project\delivery.json', 'project\final-summary.json') 'The completion record says the candidate was exported but art quality was not finally accepted and it was not deployed.'
Add-OutputDecision '2026-10-22-selene-attack-animation' 'output\skill\skill-action-107f-24fps-transparent.webm' 'Transparent skill animation art candidate' 'pending' @('project\delivery.json', 'project\final-summary.json') 'The completion record says the candidate was exported but art quality was not finally accepted and it was not deployed.'
Add-OutputDecision '2026-10-22-selene-attack-animation' 'output\Selene_两种攻击候选_107帧_透明素材.zip' 'Packaged transparent animation art candidates' 'pending' @('project\delivery.json', 'project\final-summary.json') 'The completion record identifies exported candidates, with visual acceptance and game deployment still pending.'
Add-OutputDecision '2026-10-23-selene-anime-to-pixel' 'output\17_像素化工作流默认输出_25帧透明.webm' 'Transparent pixel-animation workflow candidate' 'pending' @('project\delivery.json', 'evidence\final-checks.json') 'The tested workflow names this transparent output; aesthetic acceptance remains pending.'
Add-OutputDecision '2026-10-23-selene-cloud-attacks' 'output\attack_25帧透明.webm' 'Transparent cloud-refined attack art candidate' 'pending' @('project\delivery.json') 'The delivery record explicitly calls this cloud-refined art a candidate, not visually approved production animation.'
Add-OutputDecision '2026-10-23-selene-cloud-attacks' 'output\skill_25帧透明.webm' 'Transparent cloud-refined skill art candidate' 'pending' @('project\delivery.json') 'The delivery record explicitly calls this cloud-refined art a candidate, not visually approved production animation.'
Add-OutputDecision '2026-10-23-selene-cloud-attacks' 'output\云端两种攻击_关键帧与透明序列.zip' 'Packaged cloud-refined art candidates' 'pending' @('project\delivery.json') 'The delivery record explicitly calls these assets candidates, not visually approved production animation.'

function Get-JsonIdentity {
  param([object]$Value)
  if ($Value -isnot [System.Collections.IDictionary]) { return @{} }
  $projectId = [string]$Value['projectId']
  $workspaceId = [string]$Value['workspaceId']
  if ($Value['project'] -is [System.Collections.IDictionary]) {
    if ([string]::IsNullOrWhiteSpace($projectId)) { $projectId = [string]$Value['project']['projectId'] }
    if ([string]::IsNullOrWhiteSpace($workspaceId)) { $workspaceId = [string]$Value['project']['workspaceId'] }
    if ([string]::IsNullOrWhiteSpace($workspaceId)) { $workspaceId = [string]$Value['project']['mainWorkspaceId'] }
  }
  $result = @{}
  if ($projectId -match '^[0-9a-fA-F-]{36}$') { $result.projectId = $projectId }
  if ($workspaceId -match '^[0-9a-fA-F-]{36}$') { $result.workspaceId = $workspaceId }
  return $result
}

function Get-JobContext {
  param([System.IO.DirectoryInfo]$Job)
  $candidatePaths = [System.Collections.Generic.List[string]]::new()
  foreach ($relative in @(
    'brief.md', 'manifest.json', 'project\manifest.json', 'project\delivery.json',
    'project\final-summary.json', 'project\summary.json', 'project\completion.json',
    'project\spec.json', 'project\制作与审片记录.txt', 'project\README.md',
    'completion.json', 'result.json', 'issues.md', 'README.md',
    'output\RESULTS.txt', 'output\review-results.txt'
  )) { $candidatePaths.Add($relative) }

  # Old jobs do not all have brief.md. Add concise, job-local status documents
  # from their own project/output/evidence areas so an absent brief does not
  # erase otherwise explicit usage evidence.
  foreach ($area in @('project', 'output', 'evidence', 'work', 'source', 'delivery')) {
    $areaPath = Join-Path $Job.FullName $area
    if (-not (Test-Path -LiteralPath $areaPath -PathType Container)) { continue }
    $documents = Get-ChildItem -LiteralPath $areaPath -File -Force -ErrorAction SilentlyContinue | Where-Object {
      $_.Length -le 2MB -and
      $_.Extension -in @('.md', '.txt', '.json') -and
      ($_.Extension -in @('.md', '.txt') -or $_.Name -match '(?i)(manifest|summary|result|report|audit|delivery|final|completion|spec|readme|review|acceptance|check|before|usage|identity|说明|记录|验收|状态|节奏|设计|status)') -and
      $_.Name -notmatch '(?i)(token|credential|secret|endpoint|auth|private|storage-audit)'
    } | Sort-Object FullName | Select-Object -First 32
    foreach ($document in $documents) {
      $candidatePaths.Add($document.FullName.Substring($Job.FullName.Length).TrimStart('\'))
    }
  }
  $candidatePaths = @($candidatePaths | Select-Object -Unique)
  $evidencePaths = [System.Collections.Generic.List[string]]::new()
  $texts = [System.Collections.Generic.List[string]]::new()
  $projectIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $workspaceIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $ownerEvidencePaths = [System.Collections.Generic.List[string]]::new()
  $parseIssues = [System.Collections.Generic.List[string]]::new()

  foreach ($relative in $candidatePaths) {
    $path = Join-Path $Job.FullName $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Length -gt 2MB) { continue }
    $text = [System.IO.File]::ReadAllText($path)
    $texts.Add($text)
    $evidencePaths.Add($relative)
    $hasIdentityEvidence = $false
    if ($item.Extension -eq '.json') {
      try {
        $json = $text | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        $ids = Get-JsonIdentity -Value $json
        if ($ids.projectId) { [void]$projectIds.Add([string]$ids.projectId); $hasIdentityEvidence = $true }
        if ($ids.workspaceId) { [void]$workspaceIds.Add([string]$ids.workspaceId); $hasIdentityEvidence = $true }
      }
      catch {
        $parseIssues.Add($relative)
      }
    }
    if ($relative -eq 'brief.md') {
      foreach ($match in [regex]::Matches($text, '(?i)(?:projectId|project\s*ID|项目\s*ID)\s*[:=：]\s*[`"'']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')) {
        [void]$projectIds.Add($match.Groups[1].Value)
        $hasIdentityEvidence = $true
      }
      foreach ($match in [regex]::Matches($text, '(?i)(?:workspaceId|workspace\s*ID|工作区\s*ID)\s*[:=：]\s*[`"'']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')) {
        [void]$workspaceIds.Add($match.Groups[1].Value)
        $hasIdentityEvidence = $true
      }
    }
    if ($hasIdentityEvidence) { $ownerEvidencePaths.Add($relative) }
  }

  $content = [string]::Join("`n", $texts)
  return [pscustomobject]@{
    evidencePaths = $evidencePaths.ToArray()
    ownerEvidencePaths = @($ownerEvidencePaths | Select-Object -Unique)
    content = $content
    projectId = if ($projectIds.Count -eq 1) { @($projectIds)[0] } else { $null }
    workspaceId = if ($workspaceIds.Count -eq 1) { @($workspaceIds)[0] } else { $null }
    projectIdentityState = if ($projectIds.Count -gt 1) { 'ambiguous' } elseif ($projectIds.Count -eq 1) { 'evidence-present' } else { 'unknown' }
    workspaceIdentityState = if ($workspaceIds.Count -gt 1) { 'ambiguous' } elseif ($workspaceIds.Count -eq 1) { 'evidence-present' } else { 'unknown' }
    parseIssues = $parseIssues.ToArray()
  }
}

function Get-WorkReconstructability {
  param([string]$JobName, [string]$RelativePath, [string]$Extension, [string]$Top)
  if ($Extension -in @('.ps1', '.py', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.sh', '.cmd', '.bat')) {
    return @{ value = 'not-applicable'; reason = 'This entry is a helper or workflow source, not a derived result.' }
  }
  if ($Top -eq 'evidence') {
    return @{ value = 'non-reconstructable'; reason = 'Historical validation or review evidence records a past execution/state.' }
  }
  if ($JobName -eq '2026-10-22-selene-two-attacks' -and $RelativePath -like 'delivery\render-r18\*') {
    return @{ value = 'reconstructable'; reason = 'The delivery notes identify delivery/reproduce/render_attacks.py, recipe.json, and retained input assets as the reproduction set.' }
  }
  if ($RelativePath -match '(?i)(^|[\\/])(__pycache__|node_modules|\.cache|\.remotion|asr-models|models--[^\\/]+|blobs|cache)([\\/]|$)') {
    return @{ value = 'unknown'; reason = 'Dependency/model/cache contents may be re-downloaded or regenerated, but the index does not claim a complete reproducible dependency closure.' }
  }
  if ($RelativePath -match '(?i)(preview|review|attempt|failed|candidate|draft|r\d+|frames?|render)') {
    return @{ value = 'unknown'; reason = 'The entry is a derived attempt or preview; retained inputs and execution conditions do not establish full regeneration.' }
  }
  return @{ value = 'unknown'; reason = 'Available job evidence does not establish the full inputs, versions, and execution path needed to recreate this entry.' }
}

function Get-Classification {
  param([string]$JobName, [string]$RelativePath, [System.IO.FileSystemInfo]$Item, [object]$Context)
  $key = "$JobName\$RelativePath"
  if ($outputDecisions.ContainsKey($key)) {
    return [pscustomobject]@{
      kind = 'output'; purpose = $outputDecisions[$key].purpose; confidence = 'high'
      deliveryStatus = $outputDecisions[$key].deliveryStatus
      evidencePaths = $outputDecisions[$key].evidence
      rule = $outputDecisions[$key].reason
    }
  }
  if ($sourceDecisions.ContainsKey($key)) {
    return [pscustomobject]@{
      kind = 'source'; purpose = $sourceDecisions[$key].purpose; confidence = $sourceDecisions[$key].confidence
      deliveryStatus = 'pending'; evidencePaths = $sourceDecisions[$key].evidence; rule = $sourceDecisions[$key].reason
      reconstructability = 'not-applicable'; reconstructabilityReason = 'Source input is retained at its original path.'
    }
  }

  $segments = $RelativePath -split '[\\/]'
  $top = $segments[0].ToLowerInvariant()
  $hasContext = $Context.evidencePaths.Count -gt 0
  $directMention = $false
  if ($hasContext -and -not [string]::IsNullOrWhiteSpace($Item.Name)) {
    $directMention = $Context.content.IndexOf($Item.Name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  }

  $kind = $null
  $purpose = $null
  $confidence = 'low'
  $rule = $null
  if ($RelativePath -match '(?i)(^|[\\/])reel-identity\.json$' -and $Context.evidencePaths.Count -gt 0) {
    return [pscustomobject]@{
      kind = 'project'; purpose = 'Explicit project/workspace identity record.'; confidence = 'high'
      deliveryStatus = 'pending'; evidencePaths = @($Context.evidencePaths | Select-Object -First 4)
      rule = 'The file explicitly records projectId/workspaceId; those identifiers remain separate from source/work usage.'
      reconstructability = 'not-applicable'; reconstructabilityReason = 'Project identity metadata.'
    }
  }
  switch ($top) {
    'source' {
      if ($hasContext -and ($directMention -or $Context.content -match '(?i)(source|sourcePaths|原始素材|源视频|输入素材|选用素材|输入文件)')) {
        $kind = 'source'
        $purpose = if ($directMention) { 'Input or adopted media named by job evidence.' } else { 'Input area corroborated by this job brief or manifest.' }
        $confidence = if ($directMention) { 'high' } else { 'medium' }
        $rule = 'Canonical source area plus job-specific contextual evidence; a filename/extension alone is not used to infer source ownership.'
      }
      elseif ($hasContext) {
        $kind = 'source'; $purpose = 'Job input area; exact item adoption is not enumerated.'; $confidence = 'medium'
        $rule = 'Canonical source area and an existing job brief/manifest provide context, but this individual item is not directly named.'
      }
    }
    'project' {
      if ($hasContext) {
        $kind = 'project'; $purpose = 'Project state, edit plan, configuration, or project metadata.'; $confidence = 'high'
        $rule = 'Project directory plus job brief/manifest context.'
      }
    }
    'work' {
      if ($hasContext) {
        $kind = 'work'
        $purpose = if ($RelativePath -match '(?i)(node_modules|\.cache|\.remotion|asr-models|models--|blobs|__pycache__)') { 'Derived tooling, model, or render cache.' } else { 'Helper, processing, or intermediate work product.' }
        $confidence = 'high'; $rule = 'Work area corroborated by the job brief/manifest and task records.'
      }
    }
    'generated' {
      if ($hasContext) {
        $kind = 'work'; $purpose = 'Generated attempt or derived intermediate; source/final adoption requires separate evidence.'
        $confidence = if ($directMention) { 'high' } else { 'medium' }
        $rule = 'Generated area plus job-specific process context; AI generation is purpose, not a fifth ownership kind.'
      }
    }
    'evidence' {
      if ($hasContext) {
        $kind = 'work'; $purpose = 'Historical validation, review, or execution evidence.'; $confidence = 'high'
        $rule = 'Evidence area plus task context; evidence remains work and is not a product deliverable.'
      }
    }
    'output' {
      if ($hasContext) {
        $kind = 'work'
        if ($Item.Extension -in @('.md', '.txt')) { $purpose = 'Research, review, or test-result note retained as process evidence.' }
        else { $purpose = 'Unverified preview, attempt, test, or superseded output; no final-delivery record names this file.' }
        $confidence = 'medium'; $rule = 'Output area is treated as work unless an exact brief/manifest/delivery record establishes a current deliverable.'
      }
    }
    'delivery' {
      if ($hasContext) {
        $kind = 'work'; $purpose = 'Review candidate, reproduction material, or delivery evidence not itself established as an accepted final output.'
        $confidence = 'medium'; $rule = 'Delivery-area contents remain work unless an exact completion record establishes a deliverable role.'
      }
    }
    'jobs' {
      if ($hasContext) {
        $kind = 'work'; $purpose = 'Nested task or delegated-work record retained inside the parent job.'; $confidence = 'medium'
        $rule = 'Nested task material under the documented parent job.'
      }
    }
    'skills' {
      if ($hasContext) {
        $kind = 'work'; $purpose = 'Workflow or helper skill material supporting the job.'; $confidence = 'medium'
        $rule = 'Skill/tooling material is process support, not project output.'
      }
    }
    'music' {
      if ($hasContext -and $directMention) {
        $kind = 'source'; $purpose = 'Music input directly named by job evidence.'; $confidence = 'high'
        $rule = 'Exact source mention in job context.'
      }
    }
  }

  if ($null -eq $kind -and $hasContext) {
    if ($RelativePath -match '(?i)^(brief\.md|manifest\.json|result\.json|completion\.json|issues\.md|aesthetic-design\.md|director-directive\.md)$') {
      $kind = 'project'; $purpose = 'Task brief, project metadata, or creative direction.'; $confidence = 'high'
      $rule = 'Root-level task/project document.'
    }
    elseif ($Item.Extension -in @('.ps1', '.py', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.sh', '.cmd', '.bat')) {
      $kind = 'work'; $purpose = 'Helper or workflow script.'; $confidence = 'medium'; $rule = 'Executable helper stored with the job; no media-output role is inferred from extension.'
    }
    elseif ($Item.Extension -in @('.md', '.txt', '.json', '.yaml', '.yml', '.toml')) {
      $kind = 'project'; $purpose = 'Job documentation or task metadata.'; $confidence = 'medium'; $rule = 'Document/configuration file in a contextualized job.'
    }
  }

  if ($null -eq $kind) {
    return [pscustomobject]@{
      kind = 'unknown'; purpose = 'Usage cannot be established from the available job-specific evidence.'
      confidence = 'unknown'; deliveryStatus = 'pending'; evidencePaths = @()
      rule = 'No supported contextual rule; retained as unknown rather than inferred from directory name or extension.'
    }
  }

  $deliveryStatus = 'pending'
  $evidencePaths = @($Context.evidencePaths | Select-Object -First 4)
  $reconstruction = if ($kind -eq 'work') { Get-WorkReconstructability -JobName $JobName -RelativePath $RelativePath -Extension $Item.Extension -Top $top } else { @{ value = 'not-applicable'; reason = 'Reconstructability applies to derived work entries only.' } }
  return [pscustomobject]@{
    kind = $kind; purpose = $purpose; confidence = $confidence; deliveryStatus = $deliveryStatus
    evidencePaths = $evidencePaths; rule = $rule
    reconstructability = $reconstruction.value; reconstructabilityReason = $reconstruction.reason
  }
}

$jobs = @(Get-ChildItem -LiteralPath $rootPath -Directory -Force -ErrorAction Stop | Where-Object {
  $_.Name -ne '2026-10-25-legacy-artifact-index' -and
  $_.Name -ne $indexJobName -and
  $_.Name -notlike '.legacy-job-usage-index.staging-*'
} | Sort-Object Name)

$contexts = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($job in $jobs) { $contexts[$job.Name] = Get-JobContext -Job $job }

if ($Mode -eq 'RepairOwnerEvidence') {
  $repairId = [System.Guid]::NewGuid().ToString()
  $repairRoot = Join-Path $indexJobPath ('.owner-evidence-repair-' + $repairId)
  $backupRoot = Join-Path $repairRoot 'backup'
  if (Test-Path -LiteralPath $repairRoot) { throw "Repair staging path already exists: $repairRoot" }
  foreach ($kind in @('source', 'work', 'project', 'output', 'unknown')) {
    [void][System.IO.Directory]::CreateDirectory((Join-Path $repairRoot $kind))
  }
  [void][System.IO.Directory]::CreateDirectory($backupRoot)

  $totalEntries = [long]$existingSummary.totals.entries
  $projectCandidateEntries = 0L
  $workspaceCandidateEntries = 0L
  $pairCandidateEntries = 0L
  $nestedEntriesUnbound = 0L
  $projectCandidateJobs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $workspaceCandidateJobs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $pairCandidateJobs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $replacementPairs = [System.Collections.Generic.List[object]]::new()
  $lineCounts = [ordered]@{}

  foreach ($kind in @('source', 'work', 'project', 'output', 'unknown')) {
    $originalPath = Join-Path $indexJobPath "$kind\index.jsonl"
    $temporaryPath = Join-Path $repairRoot "$kind\index.jsonl"
    $reader = [System.IO.StreamReader]::new($originalPath)
    $writer = [System.IO.StreamWriter]::new($temporaryPath, $false, [System.Text.UTF8Encoding]::new($false))
    $lineCount = 0L
    try {
      while ($null -ne ($line = $reader.ReadLine())) {
        $record = $line | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        $jobId = [string]$record['jobId']
        if (-not $contexts.ContainsKey($jobId)) { throw "Index record references an unrecognized job context: $jobId" }
        $context = $contexts[$jobId]
        $relativePath = [string]$record['relativePath']
        $isNestedJobMaterial = $relativePath -match '(?i)^jobs[\\/]'

        if ($isNestedJobMaterial) {
          $projectId = $null
          $workspaceId = $null
          $bindingBasis = 'unknown'
          $bindingScope = 'nested-job-context-not-inherited'
          $ownerEvidencePaths = @()
          $nestedEntriesUnbound++
        }
        else {
          $projectId = $context.projectId
          $workspaceId = $context.workspaceId
          $hasCandidateIdentity = -not [string]::IsNullOrWhiteSpace($projectId) -or -not [string]::IsNullOrWhiteSpace($workspaceId)
          $bindingBasis = if ($hasCandidateIdentity) { 'job-context-evidence-not-live-verified' } else { 'unknown' }
          $bindingScope = if ($hasCandidateIdentity) { 'job-context-candidate' } else { 'job-context-unknown' }
          $ownerEvidencePaths = @($context.ownerEvidencePaths | ForEach-Object { Join-Path (Join-Path $rootPath $jobId) $_ })
        }

        $ownership = $record['ownership']
        $ownership['projectId'] = $projectId
        $ownership['workspaceId'] = $workspaceId
        $ownership['nodeId'] = $null
        $ownership['bindingBasis'] = $bindingBasis
        $ownership['bindingScope'] = $bindingScope
        $ownership['ownerEvidencePaths'] = $ownerEvidencePaths

        if (-not $isNestedJobMaterial -and -not [string]::IsNullOrWhiteSpace($projectId)) {
          $projectCandidateEntries++
          [void]$projectCandidateJobs.Add($jobId)
        }
        if (-not $isNestedJobMaterial -and -not [string]::IsNullOrWhiteSpace($workspaceId)) {
          $workspaceCandidateEntries++
          [void]$workspaceCandidateJobs.Add($jobId)
        }
        if (-not $isNestedJobMaterial -and -not [string]::IsNullOrWhiteSpace($projectId) -and -not [string]::IsNullOrWhiteSpace($workspaceId)) {
          $pairCandidateEntries++
          [void]$pairCandidateJobs.Add($jobId)
        }

        $writer.WriteLine(($record | ConvertTo-Json -Depth 12 -Compress))
        $lineCount++
      }
    }
    finally {
      $reader.Dispose()
      $writer.Flush()
      $writer.Dispose()
    }

    $expectedLineCount = [long]$existingSummary['byKind'][$kind]['entries']
    if ($lineCount -ne $expectedLineCount) {
      throw "Owner-evidence repair changed the $kind JSONL row count: expected $expectedLineCount, got $lineCount"
    }
    $lineCounts[$kind] = $lineCount
    $replacementPairs.Add([pscustomobject]@{ kind = $kind; originalPath = $originalPath; temporaryPath = $temporaryPath })
  }

  $existingSummary['ownershipCoverage'] = [ordered]@{
    bindingSemantics = 'Task-context candidate association only; not per-file ownership proof and not live-verified.'
    projectIdCandidateJobs = $projectCandidateJobs.Count
    workspaceIdCandidateJobs = $workspaceCandidateJobs.Count
    ownerPairCandidateJobs = $pairCandidateJobs.Count
    projectIdAmbiguousJobs = @($contexts.Values | Where-Object projectIdentityState -eq 'ambiguous').Count
    workspaceIdAmbiguousJobs = @($contexts.Values | Where-Object workspaceIdentityState -eq 'ambiguous').Count
    projectIdCandidateEntries = $projectCandidateEntries
    projectIdUnknownEntries = $totalEntries - $projectCandidateEntries
    workspaceIdCandidateEntries = $workspaceCandidateEntries
    workspaceIdUnknownOrAmbiguousEntries = $totalEntries - $workspaceCandidateEntries
    ownerPairCandidateEntries = $pairCandidateEntries
    ownerPairUnknownOrAmbiguousEntries = $totalEntries - $pairCandidateEntries
    nestedJobEntriesOwnerUnbound = $nestedEntriesUnbound
    nodeIdCandidateEntries = 0
    originUnknownEntries = $totalEntries
  }
  $existingSummary['ownerBindingSemantics'] = 'IDs are task-context candidate associations repeated across files in a non-nested job and supported by listed job brief/manifest paths. They are not per-file ownership proof, proof that each file is referenced by that project/workspace, or live-verified. Nested jobs/ material does not inherit its parent context IDs; conflicts remain null.'
  $existingSummary['ownerEvidenceRepair'] = [ordered]@{
    repairedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    migrationId = $repairId
    recordsUpdated = $totalEntries
    nestedJobEntriesOwnerUnbound = $nestedEntriesUnbound
    jsonlRowsUnchanged = $true
    sourceFilesReadOnly = $true
    nodeIdCandidateEntries = 0
  }
  $existingSummary['ownerEvidenceRepair']['jsonlRows'] = $lineCounts
  $summaryTemporaryPath = Join-Path $repairRoot 'usage-index-summary.json'
  [System.IO.File]::WriteAllText($summaryTemporaryPath, ($existingSummary | ConvertTo-Json -Depth 24), [System.Text.UTF8Encoding]::new($false))
  $replacementPairs.Add([pscustomobject]@{
    kind = 'summary'
    originalPath = Join-Path $indexJobPath 'project\usage-index-summary.json'
    temporaryPath = $summaryTemporaryPath
  })

  $resolvedRepairRoot = [System.IO.Path]::GetFullPath($repairRoot).TrimEnd('\')
  if (-not $resolvedRepairRoot.StartsWith(($indexJobPath + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or [System.IO.Path]::GetFileName($resolvedRepairRoot) -ne ('.owner-evidence-repair-' + $repairId)) {
    throw 'Owner repair staging directory failed its fixed index-root boundary check.'
  }

  try {
    foreach ($replacement in $replacementPairs) {
      $backupPath = Join-Path $backupRoot ($replacement.kind + '.backup')
      [System.IO.File]::Replace($replacement.temporaryPath, $replacement.originalPath, $backupPath)
    }
  }
  catch {
    foreach ($replacement in $replacementPairs) {
      $backupPath = Join-Path $backupRoot ($replacement.kind + '.backup')
      if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
        [System.IO.File]::Copy($backupPath, $replacement.originalPath, $true)
      }
    }
    throw
  }

  $resolvedIndexRoot = [System.IO.Path]::GetFullPath($indexJobPath).TrimEnd('\')
  if (-not $resolvedRepairRoot.StartsWith(($resolvedIndexRoot + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to remove owner-repair staging outside the exact index directory.'
  }
  Remove-Item -LiteralPath $resolvedRepairRoot -Recurse -Force
  $existingSummary | ConvertTo-Json -Depth 12
  return
}

$counts = [ordered]@{}
foreach ($kind in @('source', 'work', 'project', 'output', 'unknown')) {
  $counts[$kind] = [ordered]@{ entries = 0L; files = 0L; links = 0L; bytes = 0L }
}
$jobCounts = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
$metadataBefore = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$scanIssues = [System.Collections.Generic.List[object]]::new()
$linkTargets = [System.Collections.Generic.List[object]]::new()
$unknownExamples = [System.Collections.Generic.List[string]]::new()
$projectOwnerEntries = 0L
$workspaceOwnerEntries = 0L
$ownerPairEntries = 0L
$nestedOwnerUnboundEntries = 0L
$projectIdAmbiguousEntries = 0L
$workspaceIdAmbiguousEntries = 0L
$writers = @{}
$stagingPath = $null

if ($Mode -eq 'Apply') {
  $stagingPath = Join-Path $rootPath ('.legacy-job-usage-index.staging-' + $migrationId)
  if (Test-Path -LiteralPath $stagingPath) { throw "Staging path already exists: $stagingPath" }
  foreach ($subdir in @('source', 'work', 'project', 'output', 'unknown')) {
    [void][System.IO.Directory]::CreateDirectory((Join-Path $stagingPath $subdir))
  }
  [void][System.IO.Directory]::CreateDirectory((Join-Path $stagingPath 'work'))
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  foreach ($kind in @('source', 'work', 'project', 'output', 'unknown')) {
    $writers[$kind] = [System.IO.StreamWriter]::new((Join-Path $stagingPath "$kind\index.jsonl"), $false, $utf8)
  }
}

foreach ($job in $jobs) {
  $context = $contexts[$job.Name]
  $jobCounts[$job.Name] = [ordered]@{
    total = [ordered]@{ entries = 0L; files = 0L; links = 0L; bytes = 0L }
    byKind = [ordered]@{
      source = [ordered]@{ entries = 0L; files = 0L; links = 0L; bytes = 0L }
      work = [ordered]@{ entries = 0L; files = 0L; links = 0L; bytes = 0L }
      project = [ordered]@{ entries = 0L; files = 0L; links = 0L; bytes = 0L }
      output = [ordered]@{ entries = 0L; files = 0L; links = 0L; bytes = 0L }
      unknown = [ordered]@{ entries = 0L; files = 0L; links = 0L; bytes = 0L }
    }
  }

  $stack = [System.Collections.Generic.Stack[string]]::new()
  $stack.Push($job.FullName)
  while ($stack.Count -gt 0) {
    $directory = $stack.Pop()
    try {
      $children = [System.IO.Directory]::GetFileSystemEntries($directory)
      [Array]::Sort($children, [System.StringComparer]::OrdinalIgnoreCase)
    }
    catch {
      $scanIssues.Add([pscustomobject]@{ path = $directory; issue = 'directory-enumeration-failed'; message = $_.Exception.Message })
      continue
    }

    foreach ($path in $children) {
      try { $attributes = [System.IO.File]::GetAttributes($path) }
      catch {
        $scanIssues.Add([pscustomobject]@{ path = $path; issue = 'attributes-read-failed'; message = $_.Exception.Message })
        continue
      }

      $isLink = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
      $isDirectory = (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
      if ($isDirectory -and -not $isLink) {
        $stack.Push($path)
        continue
      }

      try {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        $relativePath = $path.Substring($job.FullName.Length).TrimStart('\')
        $sizeBytes = if ($isLink) { 0L } else { [long]$item.Length }
        $mtime = $item.LastWriteTimeUtc.ToString('o')
        $fileType = if ($isLink -and $isDirectory) { 'junction-or-directory-link' } elseif ($isLink) { 'symbolic-link-file' } else { 'file' }
        $stamp = "$fileType|$sizeBytes|$($item.LastWriteTimeUtc.Ticks)|$($item.Target -join ';')"
        $metadataBefore[$path] = $stamp
        $isNestedJobMaterial = $relativePath -match '(?i)^jobs[\\/]'
        $classification = Get-Classification -JobName $job.Name -RelativePath $relativePath -Item $item -Context $context
        $bucket = if ($classification.kind -eq 'unknown') { 'unknown' } else { [string]$classification.kind }
        $kindCount = $counts[$bucket]
        $jobKindCount = $jobCounts[$job.Name].byKind[$bucket]
        foreach ($targetCount in @($kindCount, $jobKindCount, $jobCounts[$job.Name].total)) {
          $targetCount.entries++
          if ($isLink) { $targetCount.links++ } else { $targetCount.files++; $targetCount.bytes += $sizeBytes }
        }
        if ($isLink) {
          $targetValue = [string]($item.Target -join ';')
          $linkTargets.Add([pscustomobject]@{ path = $path; target = $targetValue; linkType = [string]$item.LinkType })
        }
        if ($bucket -eq 'unknown' -and $unknownExamples.Count -lt 30) { $unknownExamples.Add($path) }

        if ($isNestedJobMaterial) {
          $projectId = $null
          $workspaceId = $null
          $bindingBasis = 'unknown'
          $bindingScope = 'nested-job-context-not-inherited'
          $ownerEvidencePaths = @()
          $nestedOwnerUnboundEntries++
        }
        else {
          $projectId = $context.projectId
          $workspaceId = $context.workspaceId
          $hasCandidateIdentity = -not [string]::IsNullOrWhiteSpace($projectId) -or -not [string]::IsNullOrWhiteSpace($workspaceId)
          $bindingBasis = if ($hasCandidateIdentity) { 'job-context-evidence-not-live-verified' } else { 'unknown' }
          $bindingScope = if ($hasCandidateIdentity) { 'job-context-candidate' } else { 'job-context-unknown' }
          $ownerEvidencePaths = @($context.ownerEvidencePaths | ForEach-Object { Join-Path $job.FullName $_ })
          if (-not [string]::IsNullOrWhiteSpace($projectId)) { $projectOwnerEntries++ }
          if (-not [string]::IsNullOrWhiteSpace($workspaceId)) { $workspaceOwnerEntries++ }
          if (-not [string]::IsNullOrWhiteSpace($projectId) -and -not [string]::IsNullOrWhiteSpace($workspaceId)) { $ownerPairEntries++ }
          if ($context.projectIdentityState -eq 'ambiguous') { $projectIdAmbiguousEntries++ }
          if ($context.workspaceIdentityState -eq 'ambiguous') { $workspaceIdAmbiguousEntries++ }
        }
        $owner = [ordered]@{
          kind = if ($bucket -eq 'unknown') { $null } else { $bucket }
          purpose = if ($bucket -eq 'unknown') { $null } else { [string]$classification.purpose }
          projectId = $projectId
          workspaceId = $workspaceId
          nodeId = $null
          deliveryStatus = [string]$classification.deliveryStatus
          bindingBasis = $bindingBasis
          bindingScope = $bindingScope
          ownerEvidencePaths = $ownerEvidencePaths
        }
        $reconstruction = if ($classification.PSObject.Properties.Name -contains 'reconstructability') { [string]$classification.reconstructability } else { 'not-applicable' }
        $reconstructionReason = if ($classification.PSObject.Properties.Name -contains 'reconstructabilityReason') { [string]$classification.reconstructabilityReason } else { 'Not a derived work entry.' }
        $record = [ordered]@{
          originalPath = $path
          jobId = $job.Name
          relativePath = $relativePath
          ownership = $owner
          classification = [ordered]@{
            kind = [string]$classification.kind
            purpose = [string]$classification.purpose
            confidence = [string]$classification.confidence
            rule = [string]$classification.rule
            evidencePaths = @($classification.evidencePaths | ForEach-Object {
              if ([System.IO.Path]::IsPathRooted([string]$_)) { [string]$_ } else { Join-Path $job.FullName $_ }
            })
            origin = [ordered]@{ value = 'unknown'; reason = 'No trustworthy user/product/agent origin evidence was used to populate ownership.' }
            workReconstructability = $reconstruction
            workReconstructabilityReason = $reconstructionReason
          }
          file = [ordered]@{
            fileSystemObjectType = $fileType
            bytes = $sizeBytes
            lastModifiedUtc = $mtime
            linkTarget = if ($isLink) { [string]($item.Target -join ';') } else { $null }
          }
        }
        if ($Mode -eq 'Apply') {
          $writers[$bucket].WriteLine(($record | ConvertTo-Json -Depth 10 -Compress))
        }
      }
      catch {
        $scanIssues.Add([pscustomobject]@{ path = $path; issue = 'item-index-failed'; message = $_.Exception.Message })
      }
    }
  }
}

foreach ($writer in $writers.Values) { $writer.Flush(); $writer.Dispose() }

$missingOutputDecisions = [System.Collections.Generic.List[string]]::new()
foreach ($key in $outputDecisions.Keys) {
  $separator = $key.IndexOf('\')
  $jobName = $key.Substring(0, $separator)
  $relativePath = $key.Substring($separator + 1)
  $path = Join-Path (Join-Path $rootPath $jobName) $relativePath
  if (-not $metadataBefore.ContainsKey($path)) { $missingOutputDecisions.Add($path) }
}
if ($missingOutputDecisions.Count -gt 0) {
  $scanIssues.Add([pscustomobject]@{ path = $indexJobPath; issue = 'reviewed-output-decision-missing'; paths = $missingOutputDecisions.ToArray() })
}

# Recheck all indexed filesystem objects after the scan/write. Reparse points
# are checked as links only; their targets are never traversed.
$metadataChanges = [System.Collections.Generic.List[string]]::new()
foreach ($path in $metadataBefore.Keys) {
  try {
    $attributes = [System.IO.File]::GetAttributes($path)
    $isLink = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    $isDirectory = (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
    $fileType = if ($isLink -and $isDirectory) { 'junction-or-directory-link' } elseif ($isLink) { 'symbolic-link-file' } else { 'file' }
    $sizeBytes = if ($isLink) { 0L } else { [long]$item.Length }
    $stamp = "$fileType|$sizeBytes|$($item.LastWriteTimeUtc.Ticks)|$($item.Target -join ';')"
    if ($stamp -ne $metadataBefore[$path]) { $metadataChanges.Add($path) }
  }
  catch { $metadataChanges.Add($path) }
}

$summary = [ordered]@{
  format = 'reelterminal-legacy-job-usage-index/v1'
  migrationId = $migrationId
  createdAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  mode = $Mode
  sourceRoot = $rootPath
  indexJob = $indexJobName
  jobDirectories = $jobs.Count
  totals = [ordered]@{
    entries = [long](($counts.Values | ForEach-Object entries | Measure-Object -Sum).Sum)
    files = [long](($counts.Values | ForEach-Object files | Measure-Object -Sum).Sum)
    links = [long](($counts.Values | ForEach-Object links | Measure-Object -Sum).Sum)
    bytes = [long](($counts.Values | ForEach-Object bytes | Measure-Object -Sum).Sum)
  }
  byKind = $counts
  byJob = $jobCounts
  ownerBindingSemantics = 'IDs are task-context candidate associations repeated across files in a non-nested job and supported by listed job-local evidence paths. They are not per-file ownership proof or live-verified. Nested jobs/ material does not inherit parent job IDs; conflicts remain null.'
  ownershipCoverage = [ordered]@{
    bindingSemantics = 'Task-context candidate association only; not per-file ownership proof and not live-verified.'
    projectIdCandidateJobs = @($contexts.Values | Where-Object { -not [string]::IsNullOrWhiteSpace($_.projectId) }).Count
    workspaceIdCandidateJobs = @($contexts.Values | Where-Object { -not [string]::IsNullOrWhiteSpace($_.workspaceId) }).Count
    ownerPairCandidateJobs = @($contexts.Values | Where-Object { -not [string]::IsNullOrWhiteSpace($_.projectId) -and -not [string]::IsNullOrWhiteSpace($_.workspaceId) }).Count
    projectIdAmbiguousJobs = @($contexts.Values | Where-Object projectIdentityState -eq 'ambiguous').Count
    workspaceIdAmbiguousJobs = @($contexts.Values | Where-Object workspaceIdentityState -eq 'ambiguous').Count
    projectIdCandidateEntries = $projectOwnerEntries
    projectIdUnknownEntries = [long](($counts.Values | ForEach-Object entries | Measure-Object -Sum).Sum) - $projectOwnerEntries
    workspaceIdCandidateEntries = $workspaceOwnerEntries
    workspaceIdUnknownOrAmbiguousEntries = [long](($counts.Values | ForEach-Object entries | Measure-Object -Sum).Sum) - $workspaceOwnerEntries
    ownerPairCandidateEntries = $ownerPairEntries
    ownerPairUnknownOrAmbiguousEntries = [long](($counts.Values | ForEach-Object entries | Measure-Object -Sum).Sum) - $ownerPairEntries
    projectIdAmbiguousEntries = $projectIdAmbiguousEntries
    workspaceIdAmbiguousEntries = $workspaceIdAmbiguousEntries
    nestedJobEntriesOwnerUnbound = $nestedOwnerUnboundEntries
    nodeIdCandidateEntries = 0
    originUnknownEntries = [long](($counts.Values | ForEach-Object entries | Measure-Object -Sum).Sum)
  }
  explicitOutputDecisions = [ordered]@{
    reviewed = $outputDecisions.Count
    indexed = $outputDecisions.Count - $missingOutputDecisions.Count
    missing = $missingOutputDecisions.ToArray()
  }
  links = [ordered]@{
    count = $linkTargets.Count
    targetTraversal = 'none'
    targetBytesCounted = $false
    references = $linkTargets.ToArray()
  }
  scanIssues = $scanIssues.ToArray()
  metadataValidation = [ordered]@{
    objectsChecked = $metadataBefore.Count
    changedObjects = $metadataChanges.Count
    changedPaths = $metadataChanges.ToArray()
    stable = ($metadataChanges.Count -eq 0)
  }
  unknownExamples = $unknownExamples.ToArray()
  boundaries = [ordered]@{
    excludedJob = '2026-10-25-legacy-artifact-index (the earlier 81-entry owner index remains intact and outside this usage inventory).'
    excludedRoots = @(
      'E:\1Data\reelterminal\app-data',
      'E:\1Data\reelterminal\projects',
      'E:\1Data\reelterminal\review',
      'E:\1Data\reelterminal\agent-workspace\review',
      'E:\1Data\reelterminal\agent-workspace\shared'
    )
    fileMutation = 'No legacy file was moved, copied, deleted, renamed, or written by this script; only the new usage-index job is written in Apply mode.'
    databaseMutation = 'No live database, application storage, or active project was written.'
    aiClassification = 'AI/generated describes purpose only; it is not a fifth kind.'
    unknownOwnership = 'IDs are job-context candidates only, not file-level or live-verified bindings; unknown project/workspace/node/origin is left null/unknown and no owner is fabricated.'
    deletionAuthority = 'Usage classification does not grant deletion permission.'
  }
}

if ($Mode -eq 'DryRun') {
  $summary | ConvertTo-Json -Depth 12
  if ($metadataChanges.Count -gt 0) { throw 'Metadata changed during dry-run; do not apply until the legacy jobs are stable.' }
  if ($scanIssues.Count -gt 0) { throw 'Some legacy items could not be enumerated or indexed; inspect scanIssues before applying.' }
  return
}

if ($metadataChanges.Count -gt 0) { throw "Metadata changed during index creation; staging preserved at $stagingPath. Do not publish this index." }
if ($scanIssues.Count -gt 0) { throw "Some legacy items could not be indexed; staging preserved at $stagingPath. Inspect scanIssues before publishing." }

$brief = @'
# Legacy job usage index

This index organizes existing files by evidenced use and keeps every original file at its original path. The JSONL lists in `source/`, `work/`, `project/`, and `output/` reference original paths; `unknown/` contains entries whose use cannot be established from available job evidence.

Classification is independent of project/workspace/node ownership. Unknown identity and origin remain null/unknown. AI-generated status is recorded as purpose/evidence, never as a fifth kind. Work records distinguish reconstructable, non-reconstructable, unknown, and not-applicable cases where the evidence supports that distinction. An index classification never grants deletion permission.

The index excludes the earlier owner index, independent review data, app-data, saved projects, shared job assets, and live artifacts. Links are indexed as zero-byte references and are not traversed, so a shared Junction or model-cache link cannot duplicate another job's files or pull protected data into this inventory.
'@
[System.IO.File]::WriteAllText((Join-Path $stagingPath 'brief.md'), $brief, [System.Text.UTF8Encoding]::new($false))

$rollback = @'
[CmdletBinding()]
param([switch]$Execute)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedRoot = [System.IO.Path]::GetFullPath('E:\1Data\reelterminal\agent-workspace\jobs').TrimEnd('\')
$expectedJob = [System.IO.Path]::GetFullPath((Join-Path $expectedRoot '2026-10-25-legacy-job-usage-index'))
$manifestPath = Join-Path $expectedJob 'project\usage-index-summary.json'
if (-not [string]::Equals($expectedJob, 'E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-job-usage-index', [System.StringComparison]::OrdinalIgnoreCase) -or -not $expectedJob.StartsWith(($expectedRoot + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Rollback target failed the fixed jobs-root boundary check.'
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The usage-index ownership marker is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -ErrorAction Stop
if ($manifest.format -ne 'reelterminal-legacy-job-usage-index/v1' -or $manifest.migrationId -ne '__MIGRATION_ID__' -or $manifest.indexJobPath -ne $expectedJob) {
  throw 'This directory is not the usage index created by this migration.'
}
$expectedFiles = @($manifest.ownedFiles | ForEach-Object { [System.IO.Path]::GetFullPath((Join-Path $expectedJob $_)) })
$actualFiles = @(Get-ChildItem -LiteralPath $expectedJob -File -Recurse -Force -ErrorAction Stop | ForEach-Object { [System.IO.Path]::GetFullPath($_.FullName) })
if ($actualFiles.Count -ne $expectedFiles.Count) { throw 'Rollback refused: the index contains files outside the migration ownership list.' }
foreach ($file in $actualFiles) {
  if ($file -notin $expectedFiles -or -not $file.StartsWith(($expectedJob + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Rollback refused: unexpected file in index directory: $file"
  }
}
if (-not $Execute) {
  Write-Output "Dry-run only. Would remove the verified migration index directory and exactly $($actualFiles.Count) files: $expectedJob"
  return
}
Remove-Item -LiteralPath $expectedJob -Recurse -Force
Write-Output "Removed only the verified migration index: $expectedJob"
'@
$rollback = $rollback.Replace('__MIGRATION_ID__', $migrationId)
[System.IO.File]::WriteAllText((Join-Path $stagingPath 'work\rollback-usage-index.ps1'), $rollback, [System.Text.UTF8Encoding]::new($false))

$ownedFiles = [System.Collections.Generic.List[string]]::new()
$ownedFiles.Add('brief.md')
$ownedFiles.Add('project\usage-index-summary.json')
$ownedFiles.Add('work\rollback-usage-index.ps1')
foreach ($kind in @('source', 'work', 'project', 'output', 'unknown')) { $ownedFiles.Add("$kind\index.jsonl") }
$summary.mode = 'Applied'
$summary.indexJobPath = $indexJobPath
$summary.migrationId = $migrationId
$summary.ownedFiles = $ownedFiles.ToArray()
$summary.validationScope = [ordered]@{
  physicalSourcesMovedCopiedDeletedOrChanged = $false
  sourceMetadataStableDuringScan = $true
  rollbackScript = 'work/rollback-usage-index.ps1; reviewed dry-run required before any Execute use.'
}
[System.IO.File]::WriteAllText((Join-Path $stagingPath 'project\usage-index-summary.json'), ($summary | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))

Move-Item -LiteralPath $stagingPath -Destination $indexJobPath -ErrorAction Stop
$summary | ConvertTo-Json -Depth 12
