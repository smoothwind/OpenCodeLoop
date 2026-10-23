# keep-alive.ps1
# 无人值守守护：节点退出就重启，看到 DONE 才停

param(
    [string]$SessionId  = "",                        # 留空则用 -c 继续最近会话
    [string]$Project    = "D:\CodeRepos\TerminalX",
    [string]$Attach     = "http://localhost:4096",   # 留空则不 attach
    [int]   $RetryDelay = 120,                        # 两次重启间隔（秒）
    [string]$Prompt     = "读取 .progress.md，继续完成未完成的任务。全部完成后输出 DONE。请自主规划、执行、验证、迭代、反思，不得访问项目目录外的系统文件，不要中途请求确认或等待授权，失败就自己诊断修正并继续，直到任务通过验证。修改完自动提交，不要推送代码。",
    [string]$LogFile    = "keep-alive.log"
)

Set-Location -LiteralPath $Project
$done = $false

while (-not $done) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    # 组装参数（--auto 自动批准权限请求，避免无人值守时卡在授权等待）
    $args = @("run", "--format", "json", "--auto")
    if ($Attach)    { $args += @("--attach", $Attach) }
    if ($SessionId) { $args += @("-s", $SessionId) } else { $args += @("-c") }
    $args += $Prompt

    # 执行并捕获输出
    try {
        $out = & opencode @args 2>&1 | Out-String
        $code = $LASTEXITCODE
    } catch {
        $out  = $_.Exception.Message
        $code = 1
    }

    # 写日志
    Add-Content -Path $LogFile -Value "[$ts] exit=$code`n$out`n"

    # 完成信号
    if ($out -match "DONE") {
        Add-Content -Path $LogFile -Value "[$ts] 检测到 DONE，守护退出"
        $done = $true
        break
    }

    Add-Content -Path $LogFile -Value "[$ts] 进程退出，$RetryDelay 秒后重启"
    Start-Sleep -Seconds $RetryDelay
}