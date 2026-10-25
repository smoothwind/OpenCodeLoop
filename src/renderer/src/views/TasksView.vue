<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { UxButton, UxChip, UxDialog, UxIcon, UxInput, UxSegmented, UxTooltip, notify } from '@ux/components'
import { store, tasks, daemonState, saveTask, removeTask, selectTask, STATUS_META, setConfig, startTaskDaemon, startingIds, fmtLeft } from '../store'
import { api } from '../api'

const MODE_OPTIONS = [
  { value: 'last', label: '最近会话' },
  { value: 'id', label: '指定会话' },
  { value: 'new', label: '新会话' }
]

const MODE_HINTS = {
  last: '每次重启以 -c 继续最近会话（keep-alive.ps1 默认行为）',
  id: '以 -s 固定会话；会话不存在时 opencode 会自动创建',
  new: '每轮创建全新会话，上下文不延续'
}

// ---------- 新建/编辑对话框 ----------

const blankTask = () => ({
  id: '',
  name: '',
  project: '',
  attachUrl: 'http://localhost:4096',
  sessionMode: 'last',
  sessionId: '',
  model: '',
  fallbackModels: [],
  retryDelay: 120,
  maxRestarts: 0,
  sessionWaitLimitMin: 30,
  prompt:
    '读取 .progress.md，继续完成未完成的任务。全部完成后输出 DONE。请自主规划、执行、验证、迭代、反思，不得访问项目目录外的系统文件，不要中途请求确认或等待授权，失败就自己诊断修正并继续，直到任务通过验证。修改完自动提交，不要推送代码。',
  doneKeyword: 'DONE',
  autoApprove: true,
  logFile: '',
  autoStart: false
})

const dialogOpen = ref(false)
const editing = ref(blankTask())
const isNew = ref(false)
/** 脏检查：关闭前有未保存修改时确认 */
const initialSnapshot = ref('')
const savedJustNow = ref(false)

const snapshotOf = (t) =>
  JSON.stringify({ ...t, fallbackModels: [...(t.fallbackModels || [])].sort() })

const dialogDirty = computed(() => dialogOpen.value && snapshotOf(editing.value) !== initialSnapshot.value)

// 关闭（取消 / X / Esc / 遮罩）时有未保存修改 → 拦截并确认
watch(dialogOpen, (v) => {
  if (!v && dialogDirty.value && !savedJustNow.value) {
    dialogOpen.value = true
    discardOpen.value = true
  }
  savedJustNow.value = false
})

const discardOpen = ref(false)

function discardChanges() {
  savedJustNow.value = true
  discardOpen.value = false
  dialogOpen.value = false
}

// 高级选项是否被自定义（summary 徽标提示）
const advancedDirty = computed(() => {
  const t = editing.value
  return !(
    (t.attachUrl || '') === 'http://localhost:4096' &&
    num(t.retryDelay, 120) === 120 &&
    num(t.maxRestarts, 0) === 0 &&
    num(t.sessionWaitLimitMin, 30) === 30 &&
    !(t.logFile || '').trim() &&
    t.autoApprove === true &&
    t.autoStart === false
  )
})

const promptLen = computed(() => (editing.value.prompt || '').length)

const VARS_HINT_DLG = '支持变量 {{project}}（项目目录）、{{date}}、{{time}}'

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function openCreate() {
  isNew.value = true
  editing.value = blankTask()
  editing.value.id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  customModel.value = false
  modelDlg.queried = false
  sessDlg.queried = false
  initialSnapshot.value = snapshotOf(editing.value)
  savedJustNow.value = false
  dialogOpen.value = true
}

function openEdit(t) {
  isNew.value = false
  editing.value = { ...t, fallbackModels: [...(t.fallbackModels || [])] }
  customModel.value = Boolean(editing.value.model || editing.value.fallbackModels.length)
  modelDlg.queried = false
  sessDlg.queried = false
  initialSnapshot.value = snapshotOf(editing.value)
  savedJustNow.value = false
  dialogOpen.value = true
  // 指定会话模式下自动查询候选，便于确认当前绑定的是哪个会话
  if (editing.value.sessionMode === 'id' && editing.value.project) querySessions()
}

async function pickProject() {
  const oldBase = editing.value.project ? editing.value.project.split('\\').filter(Boolean).pop() : ''
  const r = await api.pickFolder(editing.value.project)
  if (r && !r.canceled) {
    editing.value.project = r.path
    // 名称未手动设置（或仍为旧目录名）时自动跟随新目录名
    const newBase = r.path.split('\\').filter(Boolean).pop()
    if (!editing.value.name.trim() || editing.value.name === oldBase) editing.value.name = newBase
  }
}

async function pickLogFile() {
  const r = await api.pickFolder(editing.value.logFile || editing.value.project)
  if (r && !r.canceled) editing.value.logFile = r.path
}

async function confirmSave() {
  const t = editing.value
  if (!t.name.trim()) t.name = t.project ? t.project.split('\\').filter(Boolean).pop() : '未命名任务'
  if (!t.project.trim()) {
    notify({ type: 'warning', message: '请先配置项目目录' })
    return
  }
  t.retryDelay = num(t.retryDelay, 120)
  t.maxRestarts = num(t.maxRestarts, 0)
  t.sessionWaitLimitMin = num(t.sessionWaitLimitMin, 30)
  // 未开「自定义模型」时清空模型配置（使用会话默认）
  if (!customModel.value) {
    t.model = ''
    t.fallbackModels = []
  }
  await saveTask({ ...t })
  selectTask(t.id)
  savedJustNow.value = true
  initialSnapshot.value = snapshotOf(t)
  dialogOpen.value = false
  // 同项目多任务共用日志文件提醒（默认日志为 <项目目录>\keep-alive.log）
  const sameLog = tasks.value.some(
    (x) => x.id !== t.id && x.project === t.project && (x.logFile || '') === (t.logFile || '')
  )
  if (sameLog) {
    notify({
      type: 'warning',
      message: '同项目已有任务使用相同日志文件，两个任务将写入同一日志；建议为该任务单独指定日志文件',
      duration: 8000
    })
  }
  notify({ type: 'success', message: `${isNew.value ? '已创建' : '已保存'}任务「${t.name}」` })
}

// ---------- 对话框内会话查询（指定会话模式的候选项） ----------

const sessDlg = reactive({ loading: false, items: [], raw: '', error: '', queried: false, queriedProject: '' })

// ---------- 对话框内模型候选 ----------

const MODEL_SOURCE_OPTIONS = [
  { value: 'default', label: '会话默认' },
  { value: 'custom', label: '自定义' }
]

/** 默认使用会话中选中的模型；显式切换「自定义」才允许指定主力/可选 */
const customModel = ref(false)

function setCustomModel(on) {
  customModel.value = on
  if (!on) {
    editing.value.model = ''
    editing.value.fallbackModels = []
  }
}

const modelDlg = reactive({ loading: false, items: [], sources: [], error: '', queried: false, filter: '' })

async function queryModels() {
  modelDlg.loading = true
  try {
    const r = await api.listModels()
    modelDlg.items = r?.items || []
    modelDlg.sources = r?.sources || []
    modelDlg.error = r?.error || ''
    modelDlg.queried = true
  } finally {
    modelDlg.loading = false
  }
}

const filteredModels = computed(() => {
  const f = modelDlg.filter.trim().toLowerCase()
  const list = f ? modelDlg.items.filter((m) => m.toLowerCase().includes(f)) : modelDlg.items
  return list.slice(0, 60)
})

function setPrimaryModel(m) {
  editing.value.model = m
  notify({ type: 'info', message: `主力模型已设为 ${m}` })
}

function appendFallbackModel(m) {
  const lines = (editing.value.fallbackModels || []).filter((x) => x !== m)
  lines.push(m)
  editing.value.fallbackModels = lines
  notify({ type: 'info', message: `已加入可选模型：${m}` })
}

function fallbackText(t) {
  return (t.fallbackModels || []).join('\n')
}

function setFallbackFromText(text) {
  editing.value.fallbackModels = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

watch(
  () => editing.value.project,
  () => {
    // 项目变更后旧查询结果失效
    sessDlg.queried = false
    sessDlg.items = []
    sessDlg.error = ''
  }
)

watch(
  () => editing.value.sessionMode,
  (mode) => {
    // 切到指定会话且尚未查询过时自动查询一次
    if (mode === 'id' && editing.value.project && !sessDlg.queried) querySessions()
  }
)

async function querySessions() {
  if (!editing.value.project.trim()) {
    notify({ type: 'warning', message: '请先配置项目目录，再查询会话' })
    return
  }
  sessDlg.loading = true
  try {
    const r = await api.listSessions({ project: editing.value.project })
    sessDlg.items = r?.sessions || []
    sessDlg.raw = r?.raw || ''
    sessDlg.error = r?.error || ''
    sessDlg.queried = true
    sessDlg.queriedProject = editing.value.project
  } finally {
    sessDlg.loading = false
  }
}

function pickDlgSession(s) {
  editing.value.sessionId = s.id
}

function fmtDlgTime(t) {
  if (!t) return ''
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

// ---------- 删除确认 ----------

const delOpen = ref(false)
const delTarget = ref(null)
/** 删除任务时同步删除其绑定的会话 */
const delSyncSession = ref(false)

function askDelete(t) {
  delTarget.value = t
  delSyncSession.value = false
  delOpen.value = true
}

async function confirmDelete() {
  if (!delTarget.value) return
  const t = delTarget.value
  const name = t.name
  try {
    // 先停守护（主进程 config:set 兜底会清理孤儿）
    await api.daemonStop(t.id)
    let sessionDeleted = false
    if (delSyncSession.value && t.sessionId) {
      const r = await api.deleteSession({ sessionId: t.sessionId, project: t.project })
      sessionDeleted = r?.ok === true
      if (!sessionDeleted) {
        notify({ type: 'warning', message: `会话删除失败：${r?.error || '未知错误'}（任务仍将删除）` })
      }
    }
    await removeTask(t.id)
    notify({ type: 'success', message: `已删除任务「${name}」${sessionDeleted ? '，并同步删除其绑定会话' : ''}` })
  } catch (err) {
    notify({ type: 'danger', message: `删除任务失败：${String(err?.message || err)}` })
  } finally {
    // 无论成功失败都关闭弹窗（修复异常导致弹窗卡住）
    delOpen.value = false
    delTarget.value = null
  }
}

// ---------- 守护动作 ----------

async function start(t) {
  const r = await startTaskDaemon(t.id)
  if (r && !r.ok && r.error) notify({ type: 'danger', message: `「${t.name}」启动失败：${r.error}` })
}

function stop(t) {
  api.daemonStop(t.id)
}

function restart(t) {
  api.daemonRestart(t.id)
}

async function openLog(t) {
  const r = await api.openLogFile(t.id)
  if (r && !r.ok) notify({ type: 'warning', message: r.error || '日志文件尚不存在' })
}

// ---------- 每秒 tick（倒计时/本轮时长）：全部空闲时暂停，避免无谓重渲染 ----------

const nowTick = ref(Date.now())
const anyBusy = computed(() =>
  tasks.value.some((t) => ['running', 'waiting'].includes(daemonState(t.id).status))
)
const ticker = setInterval(() => {
  if (anyBusy.value) nowTick.value = Date.now()
}, 1000)
onBeforeUnmount(() => clearInterval(ticker))

// ---------- 全部启动 / 全部停止 ----------

const allBusy = computed(() => tasks.value.length > 0 && tasks.value.every((t) => ['running', 'waiting'].includes(daemonState(t.id).status)))

async function startAll() {
  for (const t of tasks.value) await start(t)
}

function stopAllTasks() {
  for (const t of tasks.value) api.daemonStop(t.id)
}

const meta = (t) => STATUS_META[daemonState(t.id).status] || STATUS_META.stopped

function roundOrCountdown(t) {
  const d = daemonState(t.id)
  if (d.status === 'waiting' && d.nextRestartAt) {
    // 等待原因（额度恢复/限流退避等）悬停可见；长等待人性化展示
    return fmtLeft(d.nextRestartAt - nowTick.value) + '后重启'
  }
  // 会话闸门等待：没有重启倒计时，只显示等待时长
  if (d.status === 'waiting' && d.sessionWaitStartedAt) {
    return `等待空闲 ${fmtLeft(nowTick.value - d.sessionWaitStartedAt)}`
  }
  // 仅运行中的任务计时；停止/完成/异常的任务不再计时
  if (d.status !== 'running' || !d.roundStartedAt) return '—'
  const s = Math.max(0, Math.floor((nowTick.value - d.roundStartedAt) / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

const waitLimitText = (t) => {
  const m = num(t.sessionWaitLimitMin, 30)
  return m > 0 ? `会话等待 ≤${m} 分` : '会话等待不限'
}

const modeText = (t) => (t.sessionMode === 'last' ? '最近会话' : t.sessionMode === 'id' ? '指定会话' : '新会话')

const empty = computed(() => !tasks.value.length)

// ---------- 视图模式：卡片 / 列表（任务多时用列表更紧凑） ----------

const viewMode = computed(() => (store.config.taskViewMode === 'list' ? 'list' : 'card'))
const VIEW_MODE_OPTIONS = [
  { value: 'card', label: '卡片' },
  { value: 'list', label: '列表' }
]
</script>

<template>
  <div class="ol-view" v-if="store.config">
    <div class="ol-row" style="margin-bottom: var(--ux-sp-4)">
      <span class="ol-hint">共 {{ tasks.length }} 个守护任务 · 点击卡片选中；会话/权限/提示词页作用于选中任务</span>
      <span style="flex: 1"></span>
      <UxSegmented
        :model-value="viewMode"
        size="sm"
        aria-label="视图模式"
        :options="VIEW_MODE_OPTIONS"
        @update:model-value="(v) => setConfig({ taskViewMode: v })"
      />
      <UxButton size="sm" variant="secondary" icon="act-check" label="启动全部任务" :disabled="!tasks.length || allBusy" @click="startAll">全部启动</UxButton>
      <UxButton size="sm" variant="secondary" icon="act-close" label="停止全部任务" :disabled="!tasks.length" @click="stopAllTasks">全部停止</UxButton>
      <UxButton size="sm" variant="primary" icon="act-plus" label="新建守护任务" @click="openCreate">新建任务</UxButton>
    </div>

    <!-- 空态 -->
    <div v-if="empty" class="ol-card" style="text-align: center; padding: var(--ux-sp-6)">
      <UxIcon name="act-retry" style="width: 28px; height: 28px; color: var(--ux-fg-subtle)" />
      <p style="margin: var(--ux-sp-3) 0">还没有守护任务</p>
      <UxButton size="sm" variant="primary" icon="act-plus" label="新建守护任务" @click="openCreate">新建任务</UxButton>
    </div>

    <template v-else>
      <div v-if="viewMode === 'card'" class="ol-tasks">
        <div
          v-for="t in tasks"
          :key="t.id"
          class="ol-task"
          :class="{ 'ol-task--sel': store.selectedTaskId === t.id }"
          role="button"
          tabindex="0"
          @click="selectTask(t.id)"
          @keydown.enter="selectTask(t.id)"
        >
          <div class="ol-task__head">
            <span class="ol-task__name" :title="t.name">{{ t.name }}</span>
            <UxChip :tone="meta(t).tone" :dot="meta(t).dot">{{ meta(t).text }}</UxChip>
            <UxChip v-if="t.autoStart" tone="neutral">自启</UxChip>
          </div>
          <div class="ol-task__path" :title="t.project">
            <UxIcon name="obj-folder" class="ol-task__pathicon" />
            {{ t.project || '未配置项目目录' }}
          </div>
          <div class="ol-task__meta">
            <span>{{ modeText(t) }}{{ t.sessionMode === 'id' && t.sessionId ? ' · ' + t.sessionId.slice(0, 14) : '' }}</span>
            <span>{{ t.autoApprove ? '自动批准' : '手动审批' }}</span>
            <span>间隔 {{ t.retryDelay }}s</span>
            <span>{{ t.maxRestarts > 0 ? `上限 ${t.maxRestarts} 次` : '无限重启' }}</span>
            <span v-if="num(t.sessionWaitLimitMin, 30) !== 30">{{ waitLimitText(t) }}</span>
            <span v-if="t.model">
              模型 <strong>{{ t.model }}</strong
              >{{ (t.fallbackModels || []).length ? ` +${t.fallbackModels.length} 备` : '' }}
            </span>
            <span v-if="t.onDone === 'next'" class="ol-good">迭代{{ t.maxRounds > 0 ? ` ≤${t.maxRounds} 轮` : '' }}</span>
          </div>
          <div class="ol-task__stats">
            <span>轮数 <strong>{{ daemonState(t.id).runs }}</strong></span>
            <span>
              退出
              <strong
                :class="daemonState(t.id).lastExitCode === 0 ? 'ol-good' : daemonState(t.id).lastExitCode ? 'ol-bad' : ''"
              >{{ daemonState(t.id).lastExitCode ?? '—' }}</strong>
            </span>
            <span :title="daemonState(t.id).waitReason || '本轮时长/下次重启倒计时'">本轮 <strong>{{ roundOrCountdown(t) }}</strong></span>
            <span v-if="daemonState(t.id).pid">PID <strong>{{ daemonState(t.id).pid }}</strong></span>
            <span :title="daemonState(t.id).actualModel || daemonState(t.id).model || t.model || '尚未探测到（首轮结束后显示实际模型）'">
              模型 <strong class="ol-tlist__path">{{ daemonState(t.id).actualModel || daemonState(t.id).model || t.model || '—' }}</strong>
            </span>
          </div>
          <div class="ol-task__actions" @click.stop>
            <UxButton
              size="sm"
              variant="primary"
              icon="act-check"
              label="启动该任务守护"
              :loading="startingIds.has(t.id)"
              :disabled="daemonState(t.id).status === 'running' || daemonState(t.id).status === 'waiting' || startingIds.has(t.id)"
              @click="start(t)"
            >{{ startingIds.has(t.id) ? '启动中…' : '启动' }}</UxButton>
            <UxButton
              size="sm"
              variant="secondary"
              icon="act-close"
              label="停止该任务守护"
              :disabled="daemonState(t.id).status !== 'running' && daemonState(t.id).status !== 'waiting'"
              @click="stop(t)"
            >停止</UxButton>
            <UxTooltip content="终止当前轮并跳过等待">
              <UxButton
                size="sm"
                variant="ghost"
                icon="act-retry"
                label="立即重启该任务"
                :disabled="daemonState(t.id).status !== 'running' && daemonState(t.id).status !== 'waiting'"
                @click="restart(t)"
              >重启</UxButton>
            </UxTooltip>
            <span style="flex: 1"></span>
            <UxTooltip content="打开该任务的日志文件">
              <UxButton size="sm" variant="ghost" icon="act-external-link" label="打开日志文件" @click="openLog(t)" />
            </UxTooltip>
            <UxButton size="sm" variant="ghost" icon="act-edit" label="编辑任务" @click="openEdit(t)">编辑</UxButton>
            <UxTooltip content="删除任务">
              <UxButton size="sm" variant="ghost" icon="act-delete" label="删除任务" @click="askDelete(t)" />
            </UxTooltip>
          </div>
        </div>
      </div>

      <!-- 列表模式：任务多时更紧凑 -->
      <div v-else class="ol-tlist">
        <div class="ol-tlist__head" aria-hidden="true">
          <span>任务</span>
          <span>状态</span>
          <span>项目</span>
          <span>会话</span>
          <span class="ol-tlist__num">轮数</span>
          <span class="ol-tlist__num">本轮/倒计时</span>
          <span class="ol-tlist__ops">操作</span>
        </div>
        <div
          v-for="t in tasks"
          :key="t.id"
          class="ol-tlist__row"
          :class="{ 'ol-tlist__row--sel': store.selectedTaskId === t.id }"
          role="button"
          tabindex="0"
          @click="selectTask(t.id)"
          @keydown.enter="selectTask(t.id)"
        >
          <span class="ol-tlist__name" :title="t.name">{{ t.name }}</span>
          <span><UxChip :tone="meta(t).tone" :dot="meta(t).dot">{{ meta(t).text }}</UxChip></span>
          <span class="ol-tlist__path" :title="t.project">{{ t.project || '未配置' }}</span>
          <span class="ol-tlist__mode">{{ modeText(t) }}</span>
          <span class="ol-tlist__num">{{ daemonState(t.id).runs }}</span>
          <span class="ol-tlist__num" :title="daemonState(t.id).waitReason || undefined">{{ roundOrCountdown(t) }}</span>
          <span class="ol-tlist__ops" @click.stop>
            <UxTooltip content="启动">
              <UxButton
                size="sm"
                variant="ghost"
                icon="act-check"
                label="启动该任务守护"
                :loading="startingIds.has(t.id)"
                :disabled="daemonState(t.id).status === 'running' || daemonState(t.id).status === 'waiting' || startingIds.has(t.id)"
                @click="start(t)"
              />
            </UxTooltip>
            <UxTooltip content="停止">
              <UxButton
                size="sm"
                variant="ghost"
                icon="act-close"
                label="停止该任务守护"
                :disabled="daemonState(t.id).status !== 'running' && daemonState(t.id).status !== 'waiting'"
                @click="stop(t)"
              />
            </UxTooltip>
            <UxTooltip content="立即重启">
              <UxButton
                size="sm"
                variant="ghost"
                icon="act-retry"
                label="立即重启该任务"
                :disabled="daemonState(t.id).status !== 'running' && daemonState(t.id).status !== 'waiting'"
                @click="restart(t)"
              />
            </UxTooltip>
            <UxTooltip content="编辑任务">
              <UxButton size="sm" variant="ghost" icon="act-edit" label="编辑任务" @click="openEdit(t)" />
            </UxTooltip>
            <UxTooltip content="删除任务">
              <UxButton size="sm" variant="ghost" icon="act-delete" label="删除任务" @click="askDelete(t)" />
            </UxTooltip>
          </span>
        </div>
      </div>
    </template>

    <!-- 新建/编辑任务 -->
    <!-- 新建/编辑任务 -->
    <UxDialog v-model:open="dialogOpen" :title="isNew ? '新建守护任务' : `编辑任务 — ${editing.name || ''}`">
      <div class="ol-taskform">
        <div class="ol-sec">基础</div>
        <div class="ol-form-row">
          <UxInput v-model="editing.name" label="任务名称" placeholder="留空则取项目目录名" />
        </div>
        <div class="ol-form-row">
          <UxInput v-model="editing.project" label="项目目录" placeholder="D:\CodeRepos\MyProject" />
          <UxButton size="sm" variant="secondary" icon="obj-folder" label="选择项目目录" @click="pickProject">浏览…</UxButton>
        </div>

    <div class="ol-sec">运行</div>

    <div class="ol-run">
      <div class="ol-run__group">
        <div class="ol-run__head">会话策略</div>
        <div class="ol-run__body">
          <div>
            <UxSegmented
              v-model="editing.sessionMode"
              size="sm"
              aria-label="会话策略"
              :options="MODE_OPTIONS"
            />
          </div>
          <span class="ol-hint">{{ MODE_HINTS[editing.sessionMode] }}</span>

          <template v-if="editing.sessionMode === 'id'">
            <div class="ol-row">
              <UxInput
                :model-value="editing.sessionId"
                label="会话 ID"
                placeholder="粘贴或从候选列表选择"
                @update:model-value="(v) => (editing.sessionId = v)"
              />
              <UxButton
                size="sm"
                variant="secondary"
                icon="act-search"
                label="查询该项目下的会话列表作为候选"
                :loading="sessDlg.loading"
                @click="querySessions"
              >查询会话</UxButton>
            </div>
            <p v-if="sessDlg.error" class="ol-note ol-note--warning">{{ sessDlg.error }}</p>
            <div v-if="sessDlg.items.length" class="ol-sess" style="max-height: 180px; overflow-y: auto">
              <div
                v-for="s in sessDlg.items"
                :key="s.id"
                class="ol-sess__item"
                :class="{ 'ol-sess__item--sel': editing.sessionId === s.id }"
                role="button"
                tabindex="0"
                @click="pickDlgSession(s)"
                @keydown.enter="pickDlgSession(s)"
              >
                <UxChip v-if="editing.sessionId === s.id" tone="success" dot>已选</UxChip>
                <span class="ol-sess__title">{{ s.title || '（无标题）' }}</span>
                <span class="ol-sess__id" :title="s.id">{{ s.id }}</span>
                <span v-if="fmtDlgTime(s.updatedAt)" class="ol-hint">{{ fmtDlgTime(s.updatedAt) }}</span>
              </div>
            </div>
            <p v-else-if="sessDlg.queried && !sessDlg.loading && !sessDlg.error" class="ol-hint">
              该项目暂未解析到会话（新项目属正常，守护首轮运行后会产生会话）。
            </p>
          </template>
        </div>
      </div>

      <div class="ol-run__group">
        <div class="ol-run__head">模型</div>
        <div class="ol-run__body">
          <div>
            <UxSegmented
              :model-value="customModel ? 'custom' : 'default'"
              size="sm"
              aria-label="模型来源"
              :options="MODEL_SOURCE_OPTIONS"
              @update:model-value="(v) => setCustomModel(v === 'custom')"
            />
          </div>
          <p v-if="!customModel" class="ol-hint">使用会话中选中的默认模型，无需配置。需要指定主力/备用模型时切换为「自定义」。</p>
          <template v-else>
            <div class="ol-row">
              <UxInput
                :model-value="editing.model"
                label="主力模型"
                placeholder="provider/model"
                hint="格式 provider/model，如 zhipu/glm-5.3-flash"
                @update:model-value="(v) => (editing.model = v)"
              />
              <UxButton
                size="sm"
                variant="secondary"
                icon="act-search"
                label="查询可用模型候选"
                :loading="modelDlg.loading"
                @click="queryModels"
              >查询模型</UxButton>
            </div>
            <template v-if="modelDlg.queried">
              <p v-if="modelDlg.error" class="ol-hint">{{ modelDlg.error }}</p>
              <p v-else class="ol-hint">
                候选 {{ modelDlg.items.length }} 个（来源：{{ modelDlg.sources.join(' + ') }}）
                <input
                  class="ol-textarea"
                  style="min-height: 0; padding: 2px var(--ux-sp-2)"
                  :value="modelDlg.filter"
                  placeholder="输入关键字过滤，点击候选设置主力 / 加入可选"
                  aria-label="过滤模型候选"
                  @input="(e) => (modelDlg.filter = e.target.value)"
                />
              </p>
              <div v-if="filteredModels.length" class="ol-sess" style="max-height: 180px; overflow-y: auto">
                <div
                  v-for="m in filteredModels"
                  :key="m"
                  class="ol-sess__item"
                  :class="{ 'ol-sess__item--sel': editing.model === m }"
                  role="button"
                  tabindex="0"
                  @click="setPrimaryModel(m)"
                  @keydown.enter="setPrimaryModel(m)"
                >
                  <UxChip v-if="editing.model === m" tone="success" dot>主力</UxChip>
                  <UxChip v-else-if="(editing.fallbackModels || []).includes(m)" tone="neutral">可选</UxChip>
                  <span class="ol-sess__id" style="flex: 1">{{ m }}</span>
                  <UxTooltip content="加入可选模型链">
                    <UxButton size="sm" variant="ghost" icon="act-plus" label="加入可选" @click.stop="appendFallbackModel(m)" />
                  </UxTooltip>
                </div>
              </div>
            </template>
            <div>
              <span class="ol-hint" style="display: block; margin-bottom: 4px">
                可选模型（每行一个，主力连续失败后按序顺延，恢复后自动回到主力）
              </span>
              <textarea
                class="ol-textarea"
                style="min-height: 84px; font-family: var(--ux-font-family-mono); font-size: var(--ux-fs-xs)"
                :value="fallbackText(editing)"
                aria-label="可选模型列表"
                placeholder="provider/model"
                @input="(e) => setFallbackFromText(e.target.value)"
              ></textarea>
            </div>
          </template>
        </div>
      </div>
    </div>

        <div class="ol-sec">提示词</div>
        <textarea
          class="ol-textarea"
          style="min-height: 110px"
          :value="editing.prompt"
          aria-label="任务提示词"
          placeholder="每轮守护传给 opencode 的提示词…"
          @input="(e) => (editing.prompt = e.target.value)"
        ></textarea>
        <div class="ol-row">
          <span class="ol-hint">{{ promptLen }} 字</span>
          <span class="ol-hint">{{ VARS_HINT_DLG }}</span>
        </div>
        <div class="ol-form-row">
          <UxInput
            :model-value="editing.doneKeyword"
            label="完成标记"
            placeholder="DONE"
            hint="输出中出现该字样即完成本轮"
            @update:model-value="(v) => (editing.doneKeyword = v)"
          />
        </div>
        <div class="ol-form-row">
          <span class="ol-form__label">完成后</span>
          <UxSegmented
            :model-value="editing.onDone === 'next' ? 'next' : 'stop'"
            size="sm"
            aria-label="完成后动作"
            :options="[
              { value: 'stop', label: '停止守护' },
              { value: 'next', label: '自动下一轮（迭代）' }
            ]"
            @update:model-value="(v) => (editing.onDone = v)"
          />
          <UxInput
            v-if="editing.onDone === 'next'"
            class="ol-num"
            :model-value="String(editing.maxRounds)"
            label="总轮数上限"
            placeholder="0"
            hint="0 = 无限迭代"
            @update:model-value="(v) => (editing.maxRounds = num(v, 0))"
          />
        </div>
        <p v-if="editing.onDone === 'next'" class="ol-hint">
          迭代模式：每轮完成（输出完成标记）后自动开始下一轮，持续改进；达到总轮数上限后停止（0 = 无限迭代）。
        </p>

        <details class="ol-adv">
          <summary>
            高级选项（attach / 重启策略 / 日志 / 权限与自启）
            <span v-if="advancedDirty" class="ol-adv__dot" title="高级选项包含自定义配置"></span>
          </summary>
          <div class="ol-adv__body">
            <div class="ol-form-row">
              <UxInput v-model="editing.attachUrl" label="attach 服务地址" placeholder="http://localhost:4096（可留空）" />
            </div>
            <div class="ol-form-row">
              <UxInput
                class="ol-num"
                :model-value="String(editing.retryDelay)"
                label="重启间隔（秒）"
                @update:model-value="(v) => (editing.retryDelay = num(v, 120))"
              />
              <UxInput
                class="ol-num"
                :model-value="String(editing.maxRestarts)"
                label="重启上限（0=无限）"
                @update:model-value="(v) => (editing.maxRestarts = num(v, 0))"
              />
            </div>
            <div class="ol-form-row">
              <UxInput
                class="ol-num"
                :model-value="String(num(editing.sessionWaitLimitMin, 30))"
                label="会话等待上限（分钟）"
                hint="0 = 不限；目标会话运行中或有排队消息时先等待空闲再发送"
                @update:model-value="(v) => (editing.sessionWaitLimitMin = num(v, 30))"
              />
            </div>
            <div class="ol-form-row">
              <UxInput v-model="editing.logFile" label="日志文件" placeholder="留空 = <项目目录>\keep-alive.log" />
              <UxButton size="sm" variant="secondary" icon="obj-folder" label="选择日志文件" @click="pickLogFile">浏览…</UxButton>
            </div>
            <div class="ol-row">
              <label class="ol-check">
                <input type="checkbox" v-model="editing.autoApprove" />
                自动批准权限（--auto，无人值守必备）
              </label>
              <label class="ol-check">
                <input type="checkbox" v-model="editing.autoStart" />
                应用启动时自动运行
              </label>
            </div>
          </div>
        </details>
      </div>
      <template #footer>
        <div class="ol-actions" style="justify-content: flex-end">
          <UxButton size="sm" variant="ghost" label="取消" @click="dialogOpen = false">取消</UxButton>
          <UxButton size="sm" variant="primary" icon="act-save" label="保存任务" @click="confirmSave">保存</UxButton>
        </div>
      </template>
    </UxDialog>

    <!-- 放弃未保存修改确认 -->
    <UxDialog v-model:open="discardOpen" title="放弃未保存的修改？">
      <p style="margin: 0">当前任务有未保存的修改，关闭将丢弃这些更改。</p>
      <template #footer>
        <div class="ol-actions" style="justify-content: flex-end">
          <UxButton size="sm" variant="ghost" label="继续编辑" @click="discardOpen = false">继续编辑</UxButton>
          <UxButton size="sm" variant="danger" icon="act-delete" label="放弃更改" @click="discardChanges">放弃更改</UxButton>
        </div>
      </template>
    </UxDialog>

    <!-- 删除确认 -->
    <UxDialog v-model:open="delOpen" title="删除任务">
      <p style="margin: 0 0 var(--ux-sp-2)">
        确认删除任务「{{ delTarget?.name }}」？仅移除管理条目，不影响已产生的代码提交与日志文件；运行中的守护会先停止。
      </p>
      <label v-if="delTarget?.sessionId" class="ol-check">
        <input type="checkbox" v-model="delSyncSession" />
        同时删除该任务绑定的会话
        <span class="ol-mono">（{{ delTarget.sessionId.slice(0, 16) }}…，不可恢复）</span>
      </label>
      <template #footer>
        <div class="ol-actions" style="justify-content: flex-end">
          <UxButton size="sm" variant="ghost" label="取消删除" @click="delOpen = false">取消</UxButton>
          <UxButton size="sm" variant="danger" icon="act-delete" label="确认删除" @click="confirmDelete">删除</UxButton>
        </div>
      </template>
    </UxDialog>
  </div>
</template>
