[CmdletBinding()]
param(
  [string]$DryRunPath = 'E:\Temp\reelterminal-legacy-job-index-dry-run-2026-10-25.json',
  [string]$Root = 'E:\1Data\reelterminal\agent-workspace\jobs'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedRoot = [System.IO.Path]::GetFullPath('E:\1Data\reelterminal\agent-workspace\jobs').TrimEnd('\')
$rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
if (-not [string]::Equals($rootPath, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "This one-time index is limited to $expectedRoot"
}
if (-not (Test-Path -LiteralPath $DryRunPath -PathType Leaf)) {
  throw "Reviewed dry-run file is missing: $DryRunPath"
}

$dryRun = Get-Content -LiteralPath $DryRunPath -Raw | ConvertFrom-Json -ErrorAction Stop
if ($dryRun.format -ne 'reelterminal-legacy-job-index-dry-run/v1' -or $dryRun.sourceRoot -ne $rootPath) {
  throw 'The dry-run format or source root does not match this migration.'
}
if ($dryRun.summary.jobDirectories -ne 118 -or $dryRun.summary.files -ne 132577 -or $dryRun.summary.bytes -ne 68013995528) {
  throw 'The reviewed source inventory has changed; do not write an index from this dry-run.'
}
if ($dryRun.summary.records -ne 81 -or $dryRun.records.Count -ne 81 -or $dryRun.summary.deliveryPending -ne 81) {
  throw 'The reviewed candidate boundary has changed.'
}

$kindCounts = @{}
foreach ($entry in $dryRun.records) {
  if (-not $kindCounts.ContainsKey($entry.kind)) { $kindCounts[$entry.kind] = 0 }
  $kindCounts[$entry.kind]++
}
if ($kindCounts['project'] -ne 19 -or $kindCounts['source'] -ne 43 -or $kindCounts['work'] -ne 19 -or $kindCounts.ContainsKey('output')) {
  throw 'The reviewed ownership classification has changed.'
}

$indexJobName = '2026-10-25-legacy-artifact-index'
$indexJobPath = [System.IO.Path]::GetFullPath((Join-Path $rootPath $indexJobName))
if (-not $indexJobPath.StartsWith(($rootPath + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Index job path escaped the authorized jobs root.'
}
if (Test-Path -LiteralPath $indexJobPath) {
  throw "Refusing to overwrite an existing migration job: $indexJobPath"
}

$migrationId = [System.Guid]::NewGuid().ToString()
$indexPath = Join-Path $indexJobPath 'project\ownership-index.json'
$rollbackPath = Join-Path $indexJobPath 'work\rollback-index.ps1'
$briefPath = Join-Path $indexJobPath 'brief.md'
$records = [System.Collections.Generic.List[object]]::new()
$metadataChecked = 0
$identityPairs = @{}

foreach ($candidate in $dryRun.records) {
  $artifactPath = [System.IO.Path]::GetFullPath([string]$candidate.path)
  if (-not $artifactPath.StartsWith(($rootPath + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Candidate escaped the authorized legacy job root: $artifactPath"
  }
  $file = Get-Item -LiteralPath $artifactPath -ErrorAction Stop
  $reviewedTime = $candidate.lastModified
  if ($reviewedTime -isnot [DateTime]) { $reviewedTime = [DateTime]::Parse([string]$reviewedTime) }
  if ($file.Length -ne [long]$candidate.bytes -or $file.LastWriteTimeUtc.Ticks -ne ([DateTimeOffset]$reviewedTime).UtcDateTime.Ticks) {
    throw "Candidate metadata changed after review: $artifactPath"
  }
  $metadataChecked++

  $manifestPath = [System.IO.Path]::GetFullPath([string]$candidate.evidence.manifestPath)
  if (-not $manifestPath.StartsWith(($rootPath + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Ownership evidence escaped the authorized legacy job root: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  if ([string]$manifest.projectId -ne [string]$candidate.projectId -or [string]$manifest.workspaceId -ne [string]$candidate.workspaceId) {
    throw "Manifest identity does not match the reviewed owner for: $artifactPath"
  }
  $identityPairs["$($candidate.projectId)|$($candidate.workspaceId)"] = $true

  $verified = $null
  if ($manifest.Contains('verified')) { $verified = ($manifest.verified -eq $true) }
  $finalVideoExported = $null
  if ($manifest.Contains('finalVideoExported')) { $finalVideoExported = ($manifest.finalVideoExported -eq $true) }
  $explicitDeliveryStatus = $null
  if ($manifest.Contains('deliveryStatus')) { $explicitDeliveryStatus = [string]$manifest.deliveryStatus }
  elseif ($manifest.Contains('delivery') -and $manifest['delivery'] -is [System.Collections.IDictionary] -and $manifest['delivery'].Contains('status')) { $explicitDeliveryStatus = [string]$manifest['delivery']['status'] }

  $ownership = [ordered]@{
    kind = [string]$candidate.kind
    purpose = [string]$candidate.purpose
    projectId = [string]$candidate.projectId
    workspaceId = [string]$candidate.workspaceId
  }
  $evidence = [ordered]@{
    classification = [ordered]@{
      manifestPath = $manifestPath
      manifestField = [string]$candidate.evidence.manifestField
      rule = [string]$candidate.evidence.rule
    }
    origin = [ordered]@{
      value = 'unknown'
      reason = 'The legacy manifest does not establish user, product, or agent origin; it is not inferred from a folder name or generated status.'
    }
    manifestFacts = [ordered]@{
      verified = $verified
      finalVideoExported = $finalVideoExported
      explicitDeliveryStatus = $explicitDeliveryStatus
    }
    file = [ordered]@{
      bytes = [long]$file.Length
      lastModified = $file.LastWriteTime.ToString('o')
    }
  }

  $records.Add([pscustomobject]@{
    artifactPath = $artifactPath
    ownership = $ownership
    deliveryStatus = [string]$candidate.deliveryStatus
    evidence = $evidence
  })
}

if ($metadataChecked -ne 81 -or $identityPairs.Count -ne 3) {
  throw 'The source metadata or reviewed owner-pair count does not match the approved boundary.'
}

$unresolved = @($dryRun.unresolvedReferences | ForEach-Object {
  [pscustomobject]@{
    path = $_.path
    reason = $_.reason
    manifestPath = $_.manifestPath
    manifestField = $_.field
  }
})
$crossJobEvidenceCount = 0
foreach ($reference in $unresolved) {
  if ([string]$reference.manifestPath -notlike '*\2026-10-10-promo-v9\project\manifest.json' -or [string]$reference.path -notlike '*\2026-10-06-promo-video\source\vo_v8_master.wav') { continue }
  $manifest = Get-Content -LiteralPath $reference.manifestPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  $sourceEntry = @($manifest.sources | Where-Object {
    [string]$_.id -eq 'ca7446f1-319c-4b68-8e28-8e0d597b8f4a' -and
    [string]$_.path -eq 'E:\1Data\reelterminal\agent-workspace\jobs\2026-10-06-promo-video\source\vo_v8_master.wav'
  }) | Select-Object -First 1
  $savepointNodeId = [string]$manifest.savepoint.nodeId
  if ($null -eq $sourceEntry -or $savepointNodeId -ne '1b8cd3a0-e339-4860-8943-e49d8a187970') {
    throw 'The reviewed cross-job media reference no longer matches its explicit manifest evidence.'
  }
  $reference | Add-Member -NotePropertyName ownerEvidence -NotePropertyValue ([ordered]@{
    projectId = [string]$manifest.projectId
    workspaceId = [string]$manifest.workspaceId
  })
  $reference | Add-Member -NotePropertyName liveReferenceCheck -NotePropertyValue ([ordered]@{
    command = 'media.references'
    mediaId = [string]$sourceEntry.id
    referenceCount = 18
    savepointNodeId = $savepointNodeId
    savepointRevision = [int]$manifest.savepoint.revision
    savepointNodeFoundByNodeList = $true
    checkedReadOnly = $true
    classification = 'Retained as unresolved cross-job evidence; outside the 81-record approved index boundary.'
  })
  $crossJobEvidenceCount++
}
if ($crossJobEvidenceCount -ne 1) { throw 'The reviewed cross-job reachability evidence was not found exactly once.' }
$index = [ordered]@{
  format = 'reelterminal-legacy-artifact-ownership-index/v1'
  migrationId = $migrationId
  createdAt = [DateTimeOffset]::Now.ToString('o')
  indexPath = $indexPath
  rollbackPath = $rollbackPath
  sourceScope = [ordered]@{
    root = $rootPath
    jobDirectoriesBeforeIndex = [int]$dryRun.summary.jobDirectories
    filesBeforeIndex = [long]$dryRun.summary.files
    bytesBeforeIndex = [long]$dryRun.summary.bytes
  }
  ownerIdentityAudit = [ordered]@{
    evidence = 'Live read-only project.list and workspace.list; every candidate manifest pair matched.'
    matchedManifests = [int]$dryRun.summary.manifestsWithProjectAndWorkspaceId
    distinctPairs = $identityPairs.Count
    projectStateReopened = $false
    projectStateLimit = 'The GUI had no open video project and read-only access; project.get_state exceeded the live response limit. No project was opened or retargeted.'
  }
  summary = [ordered]@{
    records = $records.Count
    byKind = [ordered]@{ project = 19; source = 43; work = 19; output = 0 }
    deliveryPending = 81
    nodeIdRecorded = 0
    crossJobNodeEvidence = 1
    originUnknown = 81
  }
  constraints = @(
    'This index references existing files by absolute path; it does not move, copy, rename, or delete them.',
    'AI/generated status is recorded only in purpose/evidence; it is not a fifth kind.',
    'Only explicit manifest ownership and existing in-job paths are indexed.',
    'Independent review data, app-data, saved .oreel projects, shared assets, and unclassified job files remain outside this index.'
  )
  excludedRoots = @(
    'E:\1Data\reelterminal\app-data',
    'E:\1Data\reelterminal\projects',
    'E:\1Data\reelterminal\review',
    'E:\1Data\reelterminal\agent-workspace\review',
    'E:\1Data\reelterminal\agent-workspace\shared'
  )
  validation = [ordered]@{
    beforeWrite = [ordered]@{ candidateFilesChecked = $metadataChecked; bytesAndMtimeMatchDryRun = $true }
    representativeDecodeBefore = @(
      [pscustomobject]@{ kind = 'source'; mediaType = '.mp4'; basename = 'ink.mp4'; ffmpegExitCode = 0 },
      [pscustomobject]@{ kind = 'source'; mediaType = '.wav'; basename = 'body-score.wav'; ffmpegExitCode = 0 },
      [pscustomobject]@{ kind = 'work'; mediaType = '.png'; basename = 'dream-first.png'; ffmpegExitCode = 0 },
      [pscustomobject]@{ kind = 'work'; mediaType = '.mp4'; basename = 'R99-montage-preview.mp4'; ffmpegExitCode = 0 },
      [pscustomobject]@{ kind = 'work'; mediaType = '.png'; basename = 'contact-first.png'; ffmpegExitCode = 0 }
    )
    afterWrite = $null
    independentWorkspaceRead = [ordered]@{
      mediaListAvailable = $false
      mediaReferencesSample = 'One manifest-listed source media ID was read through media.references and is referenced by the manifest savepoint node.'
      nodeMediaSample = 'One listed node returned 87 media entries with blob=null and zero missing dependencies; this is a sample, not a full-project reopening.'
    }
  }
  unknowns = [ordered]@{
    unclassifiedFiles = [ordered]@{
      count = [long]$dryRun.summary.unclassifiedFiles
      handling = 'Keep at original path; no whole-job inference.'
    }
    manifestsWithoutBothIdentityFields = [int]($dryRun.summary.manifests - $dryRun.summary.manifestsWithProjectAndWorkspaceId)
    unresolvedReferences = $unresolved
    origins = [ordered]@{ count = 81; value = 'unknown'; handling = 'Preserve unknown; do not infer origin.' }
  }
  records = @($records)
}

$rollbackScript = @'
[CmdletBinding()]
param([switch]$Execute)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedJob = [System.IO.Path]::GetFullPath('E:\1Data\reelterminal\agent-workspace\jobs\2026-10-25-legacy-artifact-index')
$expectedWork = [System.IO.Path]::GetFullPath((Join-Path $expectedJob 'work'))
$expectedIndex = [System.IO.Path]::GetFullPath((Join-Path $expectedJob 'project\ownership-index.json'))
$scriptDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
if (-not [string]::Equals($scriptDirectory, $expectedWork, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Rollback script is outside its authorized migration job.'
}
if (-not $expectedIndex.StartsWith(($expectedJob + '\project\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Ownership index path escaped the authorized project directory.'
}
if (-not (Test-Path -LiteralPath $expectedIndex -PathType Leaf)) {
  throw 'The ownership index does not exist; nothing to remove.'
}

$index = Get-Content -LiteralPath $expectedIndex -Raw | ConvertFrom-Json -ErrorAction Stop
if ($index.format -ne 'reelterminal-legacy-artifact-ownership-index/v1' -or $index.migrationId -ne '__MIGRATION_ID__' -or $index.indexPath -ne $expectedIndex) {
  throw 'The file at the authorized path is not the index created by this migration.'
}

if (-not $Execute) {
  Write-Output "Dry-run only. Would remove this file and nothing else: $expectedIndex"
  return
}

Remove-Item -LiteralPath $expectedIndex -Force
Write-Output "Removed the ownership index file only: $expectedIndex"
'@
$rollbackScript = $rollbackScript.Replace('__MIGRATION_ID__', $migrationId)

$brief = @"
# Legacy artifact ownership index

This migration job contains a path-reference index for 81 existing artifacts from `$rootPath. It does not relocate, copy, rename, or delete source files. The index records `kind`, `purpose`, project/workspace identity, delivery status, classification evidence, origin evidence, size, and last-modified time.

`source` includes only files explicitly listed as project sources. Generated media used as a source remains kind `source`; generated attempts without adoption evidence and preview/sample renders remain kind `work`. Independent review storage, app-data, `.oreel` files, shared assets, and unknown legacy artifacts remain at their original paths.

The rollback script defaults to dry-run. `-Execute` removes only `project/ownership-index.json` after checking its exact directory, format, and migration ID. It leaves this migration job and every indexed original file in place.
"@

New-Item -ItemType Directory -Path (Join-Path $indexJobPath 'project'), (Join-Path $indexJobPath 'work') -Force:$false | Out-Null
[System.IO.File]::WriteAllText($briefPath, $brief, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($rollbackPath, $rollbackScript, [System.Text.UTF8Encoding]::new($false))
$indexJson = ConvertTo-Json -InputObject $index -Depth 12
[System.IO.File]::WriteAllText($indexPath, $indexJson, [System.Text.UTF8Encoding]::new($false))

Write-Output ([pscustomobject]@{
  indexPath = $indexPath
  rollbackPath = $rollbackPath
  migrationId = $migrationId
  records = $records.Count
  candidateFilesChecked = $metadataChecked
  ownerPairs = $identityPairs.Count
  byKind = $index.summary.byKind
} | ConvertTo-Json -Depth 4)
