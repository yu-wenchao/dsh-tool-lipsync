<#
  dsh-tool-lipsync 一键安装脚本
  ==============================
  自动探测本机 DeepSeek Harness (DSH) 安装位置，把插件复制进 profile 的 node_modules 并注册。

  用法：双击 安装.bat
#>

param([string]$DSHHome)

$ErrorActionPreference = 'Stop'
trap {
    Write-Host "[错误] $_" -ForegroundColor Red
    Read-Host '按回车键关闭'
    exit 1
}

$PluginName = 'dsh-tool-lipsync'
$ScriptDir  = $PSScriptRoot
$PluginSrc  = Join-Path $ScriptDir "plugin\$PluginName"

function Write-Step($msg) { Write-Host "`n[步骤] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [注意] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  [错误] $msg" -ForegroundColor Red }

function Test-PluginPackage {
    $pkgJson = Join-Path $PluginSrc 'package.json'
    if (-not (Test-Path $pkgJson)) { return $false }
    try {
        $pkg = Get-Content $pkgJson -Raw -Encoding utf8 | ConvertFrom-Json
        if ($pkg.name -ne $PluginName) { return $false }
        if (-not $pkg.dsh.bundle.patch) { return $false }
        if (-not (Test-Path (Join-Path $PluginSrc ($pkg.dsh.bundle.patch)))) { return $false }
        if (-not (Test-Path (Join-Path $PluginSrc 'lib\index.js'))) { return $false }
        return $true
    } catch { return $false }
}

function Copy-PluginToNodeModules {
    param($Dest)
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    Copy-Item -Recurse -Force $PluginSrc $Dest
    Remove-Item -Recurse -Force (Join-Path $Dest 'node_modules') -ErrorAction SilentlyContinue
}

function Install-IntoProfile {
    param($ProfileDir)
    $nodeModules = Join-Path $ProfileDir 'node_modules'
    $pkgJsonPath = Join-Path $ProfileDir 'package.json'
    if (-not (Test-Path $nodeModules)) {
        New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null
    }
    if (-not (Test-Path $pkgJsonPath)) {
        Write-Warn "跳过: $ProfileDir (无 package.json)"
        return $false
    }

    $target = Join-Path $nodeModules $PluginName
    try {
        Copy-PluginToNodeModules -Dest $target
        Write-Ok "已复制到: $target"
    } catch {
        Write-Err "复制失败: $_"
        return $false
    }

    try {
        $json = Get-Content $pkgJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
        $changed = $false

        # 添加到 dependencies（插件市场通过此字段识别已安装插件）
        if (-not $json.dependencies) { $json | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue @{} -Force }
        $depObj = $json.dependencies
        $pluginPath = $PluginSrc
        if ($depObj -is [System.Collections.Hashtable]) {
            if (-not $depObj.ContainsKey($PluginName)) { $depObj[$PluginName] = "file:$pluginPath"; $changed = $true }
        } else {
            if (-not $depObj.$PluginName) { $depObj | Add-Member -NotePropertyName $PluginName -NotePropertyValue "file:$pluginPath" -Force; $changed = $true }
        }

        # 添加到 bundles
        if (-not $json.dsh) { $json | Add-Member -NotePropertyName 'dsh' -NotePropertyValue @{} -Force }
        if (-not $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue @{} -Force }
        if (-not $json.dsh.profile.bundles) { $json.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue @() -Force }
        $bundles = @($json.dsh.profile.bundles | ForEach-Object { $_ })
        if ($bundles -notcontains $PluginName) { $bundles += $PluginName; $changed = $true }
        $json.dsh.profile.bundles = $bundles

        if ($changed) {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($pkgJsonPath, ($json | ConvertTo-Json -Depth 20), $utf8NoBom)
            Write-Ok "已注册到 package.json"
        } else {
            Write-Ok "已注册，无需改动"
        }
        return $true
    } catch {
        Write-Err "修改 package.json 失败: $_"
        return $false
    }
}

$script:homes = @()
function Add-Home($h) {
    if ($h -and (Test-Path $h) -and (Test-Path (Join-Path $h 'profiles')) -and ($script:homes -notcontains $h)) {
        $profiles = Join-Path $h 'profiles'
        if ((Test-Path (Join-Path $profiles 'web')) -or (Test-Path (Join-Path $profiles 'desktop'))) {
            $script:homes += $h
        }
    }
}

Write-Host ''
Write-Host '==========================================' -ForegroundColor Magenta
Write-Host '  FreeLipSync 对口型口播视频插件 一键安装' -ForegroundColor Magenta
Write-Host '  免 Key · 免登录 · 3000+ 声音 · 500+ 语言' -ForegroundColor Magenta
Write-Host '==========================================' -ForegroundColor Magenta

Write-Step '检查安装包'
if (-not (Test-Path $PluginSrc)) {
    Write-Err "找不到插件目录: $PluginSrc"
    Read-Host '按回车键退出'
    exit 1
}
if (-not (Test-PluginPackage)) {
    Write-Err '插件包校验失败'
    Read-Host '按回车键退出'
    exit 1
}
Write-Ok '安装包完整'

Write-Step '探测 DeepSeek Harness 安装位置'
Add-Home $env:DSH_HOME
if ($DSHHome -and (Test-Path $DSHHome)) { Add-Home $DSHHome }
Add-Home (Join-Path $HOME '.dsh')
$cur = $ScriptDir
for ($i = 0; $i -lt 6; $i++) {
    if ($cur -and (Test-Path $cur)) {
        if ((Test-Path (Join-Path $cur 'profiles')) -and ((Test-Path (Join-Path $cur 'profiles\web')) -or (Test-Path (Join-Path $cur 'profiles\desktop')))) {
            Add-Home $cur
        }
        $parent = Split-Path $cur
        if (-not $parent -or $parent -eq $cur) { break }
        $cur = $parent
    } else { break }
}
$drives = [System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }
foreach ($d in $drives) {
    $root = $d.RootDirectory.FullName
    try {
        $job = Start-Job -ScriptBlock { param($r) Get-ChildItem -Path $r -Depth 1 -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer -and (Test-Path (Join-Path $_.FullName 'profiles')) } | ForEach-Object { $_.FullName } } -ArgumentList $root
        if (Wait-Job $job -Timeout 10) {
            $found = Receive-Job $job -ErrorAction SilentlyContinue
            Remove-Job $job -Force -ErrorAction SilentlyContinue
            foreach ($f in $found) { Add-Home $f }
        } else {
            Stop-Job $job -ErrorAction SilentlyContinue
            Remove-Job $job -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

if ($script:homes.Count -eq 0) {
    Write-Err '未找到 DeepSeek Harness'
    Read-Host '按回车键退出'
    exit 1
}
foreach ($h in $script:homes) { Write-Ok "发现: $h" }

$selected = @()
Write-Step "发现 $($script:homes.Count) 个安装目录，请选择"
for ($i = 0; $i -lt $script:homes.Count; $i++) {
    Write-Host "  [$i] $($homes[$i])"
}
Write-Host '  [a] 全部安装'
$ans = Read-Host '请输入编号（多个用逗号分隔，或 a 全部安装）'
if ($ans -match 'a') {
    $selected = $script:homes
} else {
    foreach ($tok in ($ans -split ',' | ForEach-Object { $_.Trim() })) {
        if ($tok -match '^\d+$') {
            $idx = [int]$tok
            if ($idx -ge 0 -and $idx -lt $script:homes.Count) { $selected += $script:homes[$idx] }
        }
    }
}
if ($selected.Count -eq 0) { Write-Warn '未选择，退出'; Read-Host '按回车键退出'; exit 0 }

$installedAny = $false
foreach ($h in $selected) {
    $profilesRoot = Join-Path $h 'profiles'
    Write-Step "处理: $h"
    $profiles = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'node_modules' }
    foreach ($p in $profiles) {
        Write-Host "  安装到: $($p.Name)"
        $ok = Install-IntoProfile -ProfileDir $p.FullName
        if ($ok) { $installedAny = $true }
    }
    $sharedNm = Join-Path $profilesRoot 'node_modules'
    if (-not (Test-Path $sharedNm)) { New-Item -ItemType Directory -Force -Path $sharedNm | Out-Null }
    try {
        Copy-PluginToNodeModules -Dest (Join-Path $sharedNm $PluginName)
        Write-Ok "已复制到共享 node_modules"
        $installedAny = $true
    } catch {
        Write-Warn "共享 node_modules 复制失败（可忽略）"
    }
}

Write-Step '结果'
if ($installedAny) {
    Write-Ok '安装成功！重启 DeepSeek Harness 即可使用'
    Write-Ok '可用工具: lipsync_list_voices, lipsync_generate, lipsync_status, lipsync_download'
} else {
    Write-Warn '未成功安装到任何目录'
}

Write-Step '是否重启 DeepSeek Harness？'
$yn = Read-Host '重启？(Y/n，默认 Y)'
if ($yn -notmatch '^n') {
    try { taskkill /IM 'DeepSeekHarness.exe' /F 2>$null } catch { }
    $portConn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
    if ($portConn) { $portConn | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }
    Start-Sleep -Seconds 2
    $started = $false
    foreach ($h in $selected) {
        $rootDir = Split-Path $h
        $exe = Get-ChildItem $rootDir -Filter 'DeepSeekHarness.exe' -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
        if ($exe) {
            Write-Ok "启动: $exe"
            Start-Process $exe
            $started = $true
        }
    }
    if ($started) { Write-Ok '已重启' } else { Write-Warn '未找到 DSH，请手动启动' }
}

Write-Host ''
Read-Host '安装完成，按回车键关闭'