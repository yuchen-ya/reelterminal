[CmdletBinding()]
param(
  [string]$Root = 'E:\1Data\reelterminal\agent-workspace\jobs',
  [string]$OutputPath = (Join-Path $env:TEMP 'reelterminal-legacy-job-index-dry-run-2026-10-25.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ManifestPathValues {
  param(
    [System.Collections.IDictionary]$Manifest,
    [string]$Field
  )

  if (-not $Manifest.Contains($Field)) { return @() }
  $value = $Manifest[$Field]
  $values = [System.Collections.Generic.List[object]]::new()

  if ($value -is [string]) {
    $values.Add([pscustomobject]@{ field = $Field; value = $value })
    return $values.ToArray()
  }

  $entries = if ($value -is [array]) { $value } else { @($value) }
  foreach ($entry in $entries) {
    if ($entry -is [string]) {
      $values.Add([pscustomobject]@{ field = $Field; value = $entry })
      continue
    }

    if ($entry -is [System.Collections.IDictionary]) {
      foreach ($key in @('path', 'filePath', 'file', 'sourcePath', 'outputPath', 'src')) {
        if ($entry[$key] -is [string]) {
          $values.Add([pscustomobject]@{ field = "$Field.$key"; value = $entry[$key] })
        }
      }
    }
  }

  return $values.ToArray()
}

function Get-Classification {
  param(
    [string]$RelativePath,
    [string]$ManifestField,
    [System.Collections.IDictionary]$Manifest
  )

  $folder = ($RelativePath -split '[\\/]')[0].ToLowerInvariant()
  $fieldRoot = ($ManifestField -split '\.')[0]

  switch ($folder) {
    'source' {
      if ($fieldRoot -in @('sources', 'sourcePaths')) {
        return @{ kind = 'source'; purpose = 'Source media explicitly listed by the project manifest.'; rule = 'Manifest source field plus source directory.' }
      }
      return @{ kind = 'work'; purpose = 'Generated or referenced asset; source use is not established.'; rule = 'No explicit source field.' }
    }
    'generated' {
      if ($fieldRoot -in @('sources', 'sourcePaths')) {
        return @{ kind = 'source'; purpose = 'Generated media explicitly listed as a project source.'; rule = 'Manifest source field explicitly adopts this generated asset.' }
      }
      return @{ kind = 'work'; purpose = 'Generated asset is recorded, but adoption as source or final delivery is not established.'; rule = 'Generation evidence without a source field.' }
    }
    'work' {
      return @{ kind = 'work'; purpose = 'Intermediate work file explicitly referenced by the project manifest.'; rule = 'Manifest reference plus work directory.' }
    }
    'evidence' {
      return @{ kind = 'work'; purpose = 'Project validation evidence explicitly referenced by the project manifest.'; rule = 'Evidence remains work, not a delivered output.' }
    }
    'project' {
      return @{ kind = 'project'; purpose = 'Project file explicitly referenced by the project manifest.'; rule = 'Manifest reference plus project directory.' }
    }
    'output' {
      $deliveryStatus = [string]$Manifest['deliveryStatus']
      if ($Manifest['delivery'] -is [System.Collections.IDictionary] -and $Manifest['delivery']['status'] -is [string]) {
        $deliveryStatus = [string]$Manifest['delivery']['status']
      }
      $isVerified = $Manifest['verified'] -eq $true
      $isFinalExport = $Manifest['finalVideoExported'] -eq $true
      if ($deliveryStatus -eq 'delivered' -and $isVerified -and $isFinalExport) {
        return @{ kind = 'output'; purpose = 'Final verified project output with an explicit delivered status.'; rule = 'Manifest confirms delivery, verification, and final export.'; deliveryStatus = 'delivered' }
      }
      return @{ kind = 'work'; purpose = 'Preview or sample render; final delivery is not explicitly established.'; rule = 'Output path lacks explicit final, verified, and delivered evidence.' }
    }
    default {
      if ($fieldRoot -in @('sources', 'sourcePaths') -and $folder -eq 'music') {
        return @{ kind = 'source'; purpose = 'Music source explicitly listed by the project manifest.'; rule = 'Manifest source field explicitly adopts this asset.' }
      }
      return $null
    }
  }
}

$rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
$outputFile = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
  throw "Job root does not exist: $rootPath"
}
if ($outputFile.StartsWith(($rootPath + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Dry-run output must stay outside the legacy job root.'
}
if (Test-Path -LiteralPath $outputFile) {
  throw "Refusing to overwrite an existing dry-run file: $outputFile"
}

$jobDirectories = @(Get-ChildItem -LiteralPath $rootPath -Force -Directory -ErrorAction Stop)
$allFiles = @(Get-ChildItem -LiteralPath $rootPath -Force -Recurse -File -ErrorAction Stop)
$records = [System.Collections.Generic.List[object]]::new()
$unresolvedReferences = [System.Collections.Generic.List[object]]::new()
$identityManifestCount = 0
$manifestCount = 0
$parseErrorCount = 0

foreach ($manifestFile in Get-ChildItem -LiteralPath $rootPath -Force -Recurse -File -Filter 'manifest.json' -ErrorAction Stop) {
  $manifestCount++
  if ($manifestFile.Length -gt 1MB) { continue }

  try {
    $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  }
  catch {
    $parseErrorCount++
    continue
  }

  $projectId = [string]$manifest['projectId']
  $workspaceId = [string]$manifest['workspaceId']
  if ([string]::IsNullOrWhiteSpace($projectId) -or [string]::IsNullOrWhiteSpace($workspaceId)) { continue }
  $identityManifestCount++

  $manifestPath = [System.IO.Path]::GetFullPath($manifestFile.FullName)
  $jobRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $manifestPath))).TrimEnd('\')
  if (-not $jobRoot.StartsWith(($rootPath + '\'), [System.StringComparison]::OrdinalIgnoreCase)) { continue }

  $records.Add([pscustomobject]@{
    path = $manifestPath
    kind = 'project'
    purpose = 'Project manifest records explicit project and workspace identities.'
    projectId = $projectId
    workspaceId = $workspaceId
    deliveryStatus = 'pending'
    evidence = [pscustomobject]@{
      manifestPath = $manifestPath
      manifestField = 'projectId, workspaceId'
      rule = 'The manifest itself declares both required identity fields.'
    }
    bytes = $manifestFile.Length
    lastModified = $manifestFile.LastWriteTime.ToString('o')
  })

  foreach ($field in @('sources', 'sourcePaths', 'generatedImagePaths', 'outputPath', 'finalOutputPath', 'assets', 'evidence')) {
    foreach ($reference in Get-ManifestPathValues -Manifest $manifest -Field $field) {
      $value = [string]$reference.value
      if ([string]::IsNullOrWhiteSpace($value) -or $value.Contains("`n") -or $value.Contains("`r")) { continue }
      if (-not ([System.IO.Path]::IsPathRooted($value) -or $value.Contains('\') -or $value.Contains('/') -or $value -match '\.[A-Za-z0-9]{1,8}$')) { continue }

      try {
        $resolvedPath = if ([System.IO.Path]::IsPathRooted($value)) {
          [System.IO.Path]::GetFullPath($value)
        } else {
          [System.IO.Path]::GetFullPath((Join-Path $jobRoot $value))
        }
      }
      catch {
        $unresolvedReferences.Add([pscustomobject]@{ manifestPath = $manifestPath; field = $reference.field; path = $value; reason = 'Invalid path.' })
        continue
      }

      $inJob = $resolvedPath.StartsWith(($jobRoot + '\'), [System.StringComparison]::OrdinalIgnoreCase)
      $exists = Test-Path -LiteralPath $resolvedPath -PathType Leaf
      if (-not $inJob) {
        $unresolvedReferences.Add([pscustomobject]@{ manifestPath = $manifestPath; field = $reference.field; path = $resolvedPath; reason = if ($exists) { 'Existing path outside this job.' } else { 'Path outside this job is missing.' } })
        continue
      }
      if (-not $exists) {
        $unresolvedReferences.Add([pscustomobject]@{ manifestPath = $manifestPath; field = $reference.field; path = $resolvedPath; reason = 'Manifest path is missing.' })
        continue
      }

      $relativePath = $resolvedPath.Substring($jobRoot.Length).TrimStart('\')
      $classification = Get-Classification -RelativePath $relativePath -ManifestField $reference.field -Manifest $manifest
      if ($null -eq $classification) {
        $unresolvedReferences.Add([pscustomobject]@{ manifestPath = $manifestPath; field = $reference.field; path = $resolvedPath; reason = 'No supported classification rule.' })
        continue
      }

      $file = Get-Item -LiteralPath $resolvedPath -ErrorAction Stop
      $records.Add([pscustomobject]@{
        path = $resolvedPath
        kind = $classification.kind
        purpose = $classification.purpose
        projectId = $projectId
        workspaceId = $workspaceId
        deliveryStatus = if ($classification.ContainsKey('deliveryStatus')) { $classification['deliveryStatus'] } else { 'pending' }
        evidence = [pscustomobject]@{
          manifestPath = $manifestPath
          manifestField = $reference.field
          rule = $classification.rule
        }
        bytes = $file.Length
        lastModified = $file.LastWriteTime.ToString('o')
      })
    }
  }
}

$conflicts = @($records | Group-Object path | Where-Object {
  (@($_.Group | Select-Object -ExpandProperty kind -Unique).Count -gt 1) -or
  (@($_.Group | Select-Object -ExpandProperty projectId -Unique).Count -gt 1) -or
  (@($_.Group | Select-Object -ExpandProperty workspaceId -Unique).Count -gt 1)
})
$conflictPaths = @{}
foreach ($conflict in $conflicts) { $conflictPaths[$conflict.Name] = $true }
$finalRecords = @($records | Where-Object { -not $conflictPaths.ContainsKey($_.path) } | Sort-Object path,kind)
foreach ($conflict in $conflicts) {
  $unresolvedReferences.Add([pscustomobject]@{ path = $conflict.Name; reason = 'Conflicting project ownership or kind across manifest evidence.' })
}

$roleCounts = @($finalRecords | Group-Object kind | ForEach-Object {
  [pscustomobject]@{ kind = $_.Name; records = $_.Count }
})
$result = [pscustomobject]@{
  format = 'reelterminal-legacy-job-index-dry-run/v1'
  generatedAt = [DateTimeOffset]::Now.ToString('o')
  dryRunOnly = $true
  sourceRoot = $rootPath
  outputPath = $outputFile
  summary = [pscustomobject]@{
    jobDirectories = $jobDirectories.Count
    files = $allFiles.Count
    bytes = ($allFiles | Measure-Object -Property Length -Sum).Sum
    manifests = $manifestCount
    manifestsWithProjectAndWorkspaceId = $identityManifestCount
    parseErrors = $parseErrorCount
    records = $finalRecords.Count
    recordCountsByKind = $roleCounts
    deliveryPending = @($finalRecords | Where-Object { $_.deliveryStatus -eq 'pending' }).Count
    unresolvedReferenceCount = $unresolvedReferences.Count
    unclassifiedFiles = $allFiles.Count - $finalRecords.Count
  }
  constraints = @(
    'This report does not move, copy, rename, delete, or modify any source file.',
    'Only explicit manifest ownership and existing in-job paths are candidates.',
    'Files outside the indexed evidence remain at their original paths and are unknown.',
    'Review workspace data, app-data, and saved .oreel files are outside this source root.'
  )
  records = $finalRecords
  unresolvedReferences = @($unresolvedReferences)
}

$outputDirectory = Split-Path -Parent $outputFile
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}
$json = ConvertTo-Json -InputObject $result -Depth 8
[System.IO.File]::WriteAllText($outputFile, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output ($result.summary | ConvertTo-Json -Depth 4)
