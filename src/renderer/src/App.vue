<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { UxButton, UxChip, UxTooltip, UxToastHost, notify } from '@ux/components'
import { LogPanel } from '@ux/patterns'
import { UxActivityBar, UxAppShell, UxPanelToolbar, UxSplitPane, UxStatusBar } from '@ux/shell'
import { applyTheme, watchSystemTheme } from '@ux/tokens'
import {
  store,
  log,
  init,
  refreshAttach,
  STATUS_META,
  VIEW_TITLES,
  setConfig,
  logsVisible,
  toggleLogs,
  tasks,
  currentTask,
  selectTask,
  daemonState,
  startTaskDaemon,
  startingIds,
  fmtLeft
} from './store'
import { api } from './api'
import TasksView from './views/TasksView.vue'
import SessionsView from './views/SessionsView.vue'
import PermissionsView from './views/PermissionsView.vue'
import PromptView from './views/PromptView.vue'
import SettingsView from './views/SettingsView.vue'

const VIEWS = {
  dashboard: TasksView,
  sessions: SessionsView,
  permissions: PermissionsView,
  prompt: PromptView,
  settings: SettingsView
}

const viewComp = computed(() => VIEWS[store.view] || TasksView)

const activityItems = [
  { id: 'dashboard', icon: 'act-retry', label: '任务' },
  { id: 'sessions', icon: 'obj-folder', label: '会话' },
  { id: 'permissions', icon: 'obj-key', label: '权限' },
  { id: 'prompt', icon: 'act-edit', label: '提示词' },
  { id: 'settings', icon: 'act-settings', label: '设置' }
]

function selectView(id) {
  store.view = id
}

// ---------- 主题 ----------

const stopWatch = watchSystemTheme(() => {
  if (store.config?.theme === 'system') applyTheme('system')
})

watch(
  () => store.config?.theme,
  (t) => {
    if (t) applyTheme(t)
  }
)

// ---------- 守护动作（作用于选中任务） ----------

const curStatus = computed(() => daemonState(currentTask.value?.id).status)
const statusMeta = computed(() => STATUS_META[curStatus.value] || STATUS_META.stopped)
const busy = computed(() => curStatus.value === 'running' || curStatus.value === 'waiting')

const taskStarting = computed(() => !!currentTask.value && startingIds.has(currentTask.value.id))

async function startDaemon() {
  if (!currentTask.value) return notify({ type: 'warning', message: '请先创建任务' })
  const r = await startTaskDaemon(currentTask.value.id)
  if (r && !r.ok && r.error) notify({ type: 'danger', message: r.error })
}

async function stopDaemon() {
  if (!currentTask.value) return
  await api.daemonStop(currentTask.value.id)
}

async function restartDaemon() {
  if (!currentTask.value) return
  await api.daemonRestart(currentTask.value.id)
}

// ---------- 菜单事件 ----------

const offMenu = api.onMenuAction(async (name, payload) => {
  if (name === 'view') {
    store.view = payload
  } else if (name === 'theme') {
    await setConfig({ theme: payload })
  } else if (name === 'log:open') {
    const r = await api.openLogFile(currentTask.value?.id)
    if (r && !r.ok) notify({ type: 'warning', message: r.error || '打开失败' })
  } else if (name === 'log:reveal') {
    const r = await api.revealLogFile(currentTask.value?.id)
    if (r && !r.ok) notify({ type: 'warning', message: r.error || '未找到日志' })
  } else if (name === 'about') {
    notify({ type: 'info', message: `OpenCodeLoop v${__APP_VERSION__} — 无人值守守护管理台` })
  }
})

// ---------- 状态栏 ----------

const nowTick = ref(Date.now())
let ticker = null

onMounted(async () => {
  await init()
  refreshAttach()
  ticker = setInterval(() => (nowTick.value = Date.now()), 1000)
})

onBeforeUnmount(() => {
  clearInterval(ticker)
  offMenu?.()
  offLog?.()
  stopWatch()
})

const statusBarText = computed(() => {
  const d = daemonState(currentTask.value?.id)
  const name = currentTask.value?.name || '—'
  const head = `${name}：`
  if (d.status === 'running') return `${head}守护中 · 第 ${d.runs} 轮${d.pid ? ` · PID ${d.pid}` : ''}`
  if (d.status === 'waiting') {
    const reason = d.waitReason ? `（${d.waitReason}）` : ''
    const left = d.nextRestartAt ? ` · ${fmtLeft(d.nextRestartAt - nowTick.value)}后第 ${d.runs + 1} 轮` : ''
    return `${head}等待中${reason}${left}`
  }
  if (d.status === 'done') return `${head}已完成 · 共 ${d.runs} 轮`
  if (d.status === 'error') return `${head}${d.lastError || '异常停止'}`
  return `${head}未运行`
})

const taskSummary = computed(() => {
  let running = 0
  let waiting = 0
  for (const t of tasks.value) {
    const s = daemonState(t.id).status
    if (s === 'running') running++
    else if (s === 'waiting') waiting++
  }
  return `任务 ${tasks.value.length} · 运行 ${running} · 等待 ${waiting}`
})

const toolbarProject = computed(() => currentTask.value?.project || '未配置项目目录')

const attachText = computed(() => {
  const a = store.attach
  if (a.state === 'up') return `attach 在线 ${a.ms}ms`
  if (a.state === 'down') return 'attach 离线'
  return 'attach 未检测'
})

// 项目目录末段（D:\Code\MyApp → MyApp），用于过滤选项展示
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''

// LogPanel 门面：按任务/项目过滤后只渲染最近 300 条（环形缓冲仍有 800 条，防长跑时 DOM 膨胀）
const paneLog = computed(() => ({
  entries: computed(() => {
    const f = store.logFilterTaskId
    const list = f ? log.entries.value.filter((e) => e.taskId === f) : log.entries.value
    return list.slice(-300)
  }),
  unreadErrors: log.unreadErrors,
  markOpened: () => log.markOpened(),
  clear: () => log.clear()
}))
</script>

<template>
  <UxAppShell class="ol-shell">
    <div class="ol-body">
      <UxActivityBar
        :items="activityItems"
        :active-id="store.view"
        label="功能导航"
        @select="selectView"
      />

      <div class="ol-main">
        <UxPanelToolbar aria-label="主工具栏">
          <template #lead>
            <span class="ol-toolbar-title">{{ VIEW_TITLES[store.view] }}</span>
            <UxChip v-if="currentTask && store.view !== 'dashboard'" :tone="statusMeta.tone" :dot="statusMeta.dot">
              {{ currentTask.name }} · {{ statusMeta.text }}
            </UxChip>
          </template>
          <template #monitor>
            <UxTooltip :content="currentTask?.project || '未配置项目目录'">
              <span class="ol-toolbar-project">{{ toolbarProject }}</span>
            </UxTooltip>
            <UxTooltip content="当前任务 attach 服务健康状态（点击重新检测）">
              <UxButton size="sm" variant="ghost" icon="act-retry" :label="attachText" @click="refreshAttach">{{ attachText }}</UxButton>
            </UxTooltip>
          </template>
          <template #actions>
            <UxButton
              size="sm"
              variant="primary"
              icon="act-check"
              label="启动选中任务的守护"
              :loading="taskStarting"
              :disabled="!currentTask || busy || taskStarting"
              @click="startDaemon"
            >{{ taskStarting ? '启动中…' : '启动' }}</UxButton>
            <UxButton
              size="sm"
              variant="secondary"
              icon="act-close"
              label="停止选中任务的守护"
              :disabled="!currentTask || (!busy && !taskStarting)"
              @click="stopDaemon"
            >停止</UxButton>
            <UxTooltip content="终止当前轮并跳过等待，立刻进入下一轮">
              <UxButton
                size="sm"
                variant="ghost"
                icon="act-retry"
                label="立即重启选中任务"
                :disabled="!currentTask || !busy"
                @click="restartDaemon"
              >立即重启</UxButton>
            </UxTooltip>
            <UxTooltip :content="logsVisible() ? '隐藏日志面板' : '显示日志面板'">
              <UxButton
                size="sm"
                :variant="logsVisible() ? 'secondary' : 'ghost'"
                :aria-pressed="logsVisible()"
                icon="obj-table"
                label="切换日志面板"
                @click="toggleLogs"
              >日志</UxButton>
            </UxTooltip>
          </template>
        </UxPanelToolbar>

        <UxSplitPane
          v-if="logsVisible()"
          v-model:ratio="store.splitRatio"
          orientation="vertical"
          class="ol-split"
          label="主区与日志分屏"
        >
          <template #first>
            <component :is="viewComp" />
          </template>
          <template #second>
            <div class="ol-log-pane">
              <div class="ol-log-filter">
                <span class="ol-hint">按任务过滤</span>
                <select
                  v-model="store.logFilterTaskId"
                  class="ol-log-filter__select"
                  aria-label="按任务/项目过滤日志消息"
                >
                  <option value="">全部任务（{{ tasks.length }}）</option>
                  <option v-for="t in tasks" :key="t.id" :value="t.id">
                    {{ t.name }}{{ t.project ? ` · ${baseName(t.project)}` : '' }}
                  </option>
                </select>
              </div>
              <LogPanel :log="paneLog" label="守护日志" />
            </div>
          </template>
        </UxSplitPane>
        <component :is="viewComp" v-else class="ol-split" />

        <div v-if="!store.ready" class="ol-empty-wrap">
          <span class="ol-hint">正在加载配置…</span>
        </div>
      </div>
    </div>

    <template #statusbar>
      <UxStatusBar>
        <span class="ol-status">
          <span class="ol-status__dot" :class="`ol-status__dot--${statusMeta.tone === 'neutral' ? '' : statusMeta.tone}`"></span>
          {{ statusBarText }}
        </span>
        <template #right>
          <span class="ol-status">
            {{ taskSummary }}
            <template v-if="store.config?.autoApprove !== undefined"></template>
            · v{{ __APP_VERSION__ }}
          </span>
        </template>
      </UxStatusBar>
    </template>
  </UxAppShell>
  <UxToastHost />
</template>
