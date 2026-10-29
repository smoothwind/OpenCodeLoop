<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { UxButton, UxChip, UxDialog, UxDropdown, UxInput, UxSegmented, UxTooltip, notify } from '@ux/components'
import {
  store,
  tasks,
  currentTask,
  selectTask,
  daemonState,
  refreshSessions,
  refreshAttach,
  saveTaskDebounced,
  saveTask,
  setConfig,
  startTaskDaemon
} from '../store'
import { api } from '../api'

const DEFAULT_PROMPT =
  '读取 .progress.md，继续完成未完成的任务。全部完成后输出 DONE。请自主规划、执行、验证、迭代、反思，不得访问项目目录外的系统文件，不要中途请求确认或等待授权，失败就自己诊断修正并继续，直到任务通过验证。修改完自动提交，不要推送代码。'

const MODE_OPTIONS = [
  { value: 'last', label: '最近会话' },
  { value: 'id', label: '指定会话' },
  { value: 'new', label: '新会话' }
]

const MODE_HINTS = {
  last: '每次重启以 -c 续写本项目最近会话（下方列表第一条，与 TUI 排序一致）',
  id: '以 -s 固定续写所选会话；会话不存在时 opencode 会自动创建',
  new: '每轮创建全新会话，上下文不延续'
}

// ---------- attach 服务重启 ----------

const restartLoading = ref(false)

// ---------- 守护运行中自动轮询会话列表（15 秒，仅页面可见且守护活跃时） ----------

let pollTimer = null
const daemonActive = computed(() => {
  const st = currentTask.value ? daemonState(currentTask.value.id).status : 'stopped'
  return st === 'running' || st === 'waiting'
})

onMounted(() => {
  refreshSessions()
  refreshAttach()
  pollTimer = setInterval(() => {
    if (document.hidden) return
    // 组件仅挂载在会话视图下（视图切换即卸载），无需再判断 store.view
    if (daemonActive.value) refreshSessions()
  }, 15000)
})

onBeforeUnmount(() => clearInterval(pollTimer))

/** 守护本轮实际写入的会话 ID（事件流捕获） */
const liveSessionId = computed(() => currentTask.value ? daemonState(currentTask.value.id).sessionId : '')

// ---------- 删除会话（二次确认） ----------

const delSess = reactive({ open: false, sessionId: '', project: '', title: '', loading: false })

function askDeleteSession(sessionId, project, title) {
  delSess.sessionId = sessionId
  delSess.project = project || ''
  delSess.title = title || ''
  delSess.open = true
}

async function confirmDeleteSession() {
  if (!delSess.sessionId) return
  delSess.loading = true
  try {
    const r = await api.deleteSession({ sessionId: delSess.sessionId, project: delSess.project })
    if (r?.ok) {
      notify({ type: 'success', message: `已删除会话 ${delSess.sessionId.slice(0, 14)}…` })
      // 若删除的是当前任务绑定的会话，提示绑定已失效
      if (currentTask.value && currentTask.value.sessionId === delSess.sessionId) {
        notify({ type: 'warning', message: '该会话被当前任务绑定，续写可能失败，请在任务设置中重新选择会话' })
      }
      await Promise.all([refreshSessions(), history.queried ? scanHistory() : Promise.resolve()])
    } else {
      notify({ type: 'danger', message: `删除会话失败：${r?.error || '未知错误'}` })
    }
  } catch (err) {
    notify({ type: 'danger', message: `删除会话失败：${String(err?.message || err)}` })
  } finally {
    delSess.loading = false
    delSess.open = false
  }
}

// ---------- TUI 历史会话（跨项目，API 优先） ----------

const history = reactive({ loading: false, rows: [], total: 0, source: '', error: '', queried: false, filter: '' })

const filteredHistory = computed(() => {
  const f = history.filter.trim().toLowerCase()
  const rows = f
    ? history.rows.filter(
        (r) =>
          String(r.projectName || '').toLowerCase().includes(f) ||
          String(r.title || '').toLowerCase().includes(f) ||
          String(r.id).toLowerCase().includes(f) ||
          String(r.model || '').toLowerCase().includes(f)
      )
    : history.rows
  return rows.slice(0, 200)
})

async function scanHistory() {
  history.loading = true
  try {
    const r = await api.historySessions()
    history.rows = r?.rows || []
    history.total = r?.total || 0
    history.source = r?.source || ''
    history.error = r?.error || ''
    history.queried = true
  } finally {
    history.loading = false
  }
}

/** 由历史会话快速创建任务（绑定该会话） */
async function quickCreateFromSession(row) {
  const project = String(row.dir || row.project || '')
  if (!project) {
    notify({ type: 'warning', message: '该会话缺少项目目录信息，无法建任务' })
    return
  }
  const exist = tasks.value.find(
    (t) => t.project === project && t.sessionMode === 'id' && t.sessionId === row.id
  )
  if (exist) {
    selectTask(exist.id)
    notify({ type: 'info', message: `已存在绑定该会话的任务「${exist.name}」，已为你选中` })
    return
  }
  const projectName = row.projectName || project.split(/[\\/]/).filter(Boolean).pop() || ''
  const short = String(row.title || '').trim() || row.id.slice(0, 14)
  const name = `${projectName} · ${short.length > 24 ? short.slice(0, 24) + '…' : short}`
  const task = {
    id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    project,
    attachUrl: 'http://localhost:4096',
    sessionMode: 'id',
    sessionId: row.id,
    model: '',
    fallbackModels: [],
    retryDelay: 120,
    maxRestarts: 0,
    prompt: DEFAULT_PROMPT,
    doneKeyword: 'DONE',
    onDone: 'stop',
    maxRounds: 0,
    autoApprove: true,
    logFile: '',
    autoStart: false
  }
  await saveTask(task)
  selectTask(task.id)
  notify({
    type: 'success',
    message: `已创建任务「${name}」（绑定会话 ${row.id.slice(0, 12)}…）`,
    duration: 8000,
    action: { label: '立即启动', run: () => startTaskDaemon(task.id) }
  })
}

async function restartAttachService() {
  if (!currentTask.value) return
  if (!currentTask.value.attachUrl) {
    notify({ type: 'warning', message: '该任务未配置 attach 服务地址' })
    return
  }
  restartLoading.value = true
  // 进行中提示用有限时长（toast API 无编程关闭；按钮 loading 态已足够表达进行中）
  notify({ type: 'info', message: '正在重启 attach 服务（结束旧进程 → 拉起 opencode serve → 健康检查）…', duration: 8000 })
  try {
    const r = await api.attachRestart(currentTask.value.id)
    if (r?.ok) {
      notify({
        type: 'success',
        message: `${r.restarted ? `已结束旧进程（pid ${r.killedPid}），` : ''}opencode serve 已就绪（pid ${r.servePid}，健康检查 ${r.ms}ms）`
      })
    } else {
      notify({ type: 'danger', message: r?.message || '重启失败' })
    }
  } catch (err) {
    notify({ type: 'danger', message: `重启 attach 服务失败：${String(err?.message || err)}` })
  } finally {
    restartLoading.value = false
    refreshAttach()
  }
}

const taskItems = computed(() => tasks.value.map((t) => ({ id: t.id, label: t.name })))

function setMode(v) {
  if (!currentTask.value) return
  saveTaskDebounced({ ...currentTask.value, sessionMode: v }, 0)
}

function setSessionId(v) {
  if (!currentTask.value) return
  saveTaskDebounced({ ...currentTask.value, sessionId: v })
}

function pick(id) {
  if (!currentTask.value) return
  saveTaskDebounced({ ...currentTask.value, sessionMode: 'id', sessionId: id }, 0)
  notify({ type: 'success', message: '已选定会话（作用于当前任务）' })
}

function copyId(id) {
  navigator.clipboard?.writeText(id)
  notify({ type: 'info', message: '会话 ID 已复制' })
}

function fmtTime(t) {
  if (!t) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}
</script>

<template>
  <div class="ol-view" v-if="store.config">
    <div v-if="!currentTask" class="ol-card">
      <p class="ol-hint">尚无任务——请先在「任务」页创建守护任务，再回到这里绑定会话。</p>
    </div>

    <template v-else>
      <div class="ol-row" style="margin-bottom: var(--ux-sp-3)">
        <span class="ol-hint">作用于任务</span>
        <UxDropdown :items="taskItems" :label="currentTask.name" icon="act-retry" @select="(i) => selectTask(i.id)" />
        <UxChip :tone="store.attach.state === 'up' ? 'success' : store.attach.state === 'down' ? 'danger' : 'neutral'" dot>
          {{ store.attach.state === 'up' ? `attach 在线 ${store.attach.ms}ms` : store.attach.state === 'down' ? 'attach 离线' : 'attach 未检测' }}
        </UxChip>
      </div>

      <div class="ol-card">
        <h3 class="ol-card__title">自动会话检测</h3>
        <div class="ol-row" style="margin-bottom: var(--ux-sp-3)">
          <UxButton size="sm" variant="secondary" icon="act-retry" label="刷新会话列表" :loading="store.sessions.loading" @click="refreshSessions">刷新会话列表</UxButton>
          <UxSegmented
            :model-value="currentTask.sessionMode"
            size="sm"
            aria-label="会话策略"
            :options="MODE_OPTIONS"
            @update:model-value="setMode"
          />
          <span class="ol-hint">{{ MODE_HINTS[currentTask.sessionMode] }}</span>
        </div>

        <UxInput
          v-if="currentTask.sessionMode === 'id'"
          :model-value="currentTask.sessionId"
          label="会话 ID"
          placeholder="粘贴或从下方列表选择"
          :hint="currentTask.sessionId ? '守护重启时将以 -s 参数固定继续此会话' : '尚未指定会话 ID'"
          @update:model-value="setSessionId"
        />

        <p v-if="store.sessions.error" class="ol-note ol-note--warning" style="margin-top: var(--ux-sp-3)">
          {{ store.sessions.error }}
        </p>

        <div v-if="store.sessions.items.length" class="ol-sess" style="margin-top: var(--ux-sp-3)">
          <div
            v-for="(s, idx) in store.sessions.items.slice(0, 200)"
            :key="s.id"
            class="ol-sess__item"
            :class="{ 'ol-sess__item--sel': currentTask.sessionId === s.id }"
            role="button"
            tabindex="0"
            @click="pick(s.id)"
            @keydown.enter="pick(s.id)"
          >
            <UxChip v-if="liveSessionId === s.id" tone="success" dot>守护运行中</UxChip>
            <UxChip v-if="currentTask.sessionMode === 'last' && idx === 0" tone="warning">-c 续写</UxChip>
            <UxChip v-if="currentTask.sessionId === s.id" tone="neutral">使用中</UxChip>
            <span class="ol-sess__title" :title="s.title">{{ s.title || 'New session' }}</span>
            <span class="ol-sess__id" :title="s.id">{{ s.id }}</span>
            <span v-if="s.model" class="ol-hint" :title="'使用模型 ' + s.model">{{ s.model }}</span>
            <span v-if="fmtTime(s.updatedAt)" class="ol-hint">{{ fmtTime(s.updatedAt) }}</span>
            <UxTooltip content="复制会话 ID">
              <UxButton size="sm" variant="ghost" icon="act-copy" label="复制" @click.stop="copyId(s.id)" />
            </UxTooltip>
            <UxTooltip content="删除该会话（不可恢复）">
              <UxButton
                size="sm"
                variant="ghost"
                icon="act-delete"
                label="删除会话"
                @click.stop="askDeleteSession(s.id, currentTask.project, s.title)"
              />
            </UxTooltip>
          </div>
          <p v-if="store.sessions.items.length > 200" class="ol-hint" style="padding: var(--ux-sp-2)">
            仅显示最近 200 条（共 {{ store.sessions.items.length }} 条）。
          </p>
        </div>
        <p v-else-if="!store.sessions.loading && !store.sessions.error" class="ol-hint" style="margin-top: var(--ux-sp-3)">
          该项目暂未解析到会话。
        </p>

        <details v-if="store.sessions.raw" style="margin-top: var(--ux-sp-3)">
          <summary class="ol-hint" style="cursor: pointer">原始输出</summary>
          <pre class="ol-raw" style="margin-top: var(--ux-sp-2)">{{ store.sessions.raw }}</pre>
        </details>
      </div>

      <div class="ol-card">
        <h3 class="ol-card__title">attach 服务</h3>
        <div class="ol-row">
          <span class="ol-mono">{{ currentTask.attachUrl || '未配置' }}</span>
          <UxButton size="sm" variant="ghost" icon="act-retry" label="重新检测 attach 服务" @click="refreshAttach">重新检测</UxButton>
          <UxTooltip content="结束占用该端口的 opencode 进程并重新拉起 opencode serve，随后自动健康检查">
            <UxButton
              size="sm"
              variant="secondary"
              icon="act-split-stack"
              label="重启 attach 服务"
              :loading="restartLoading"
              :disabled="!currentTask.attachUrl"
              @click="restartAttachService"
            >重启服务</UxButton>
          </UxTooltip>
        </div>
        <p v-if="store.attach.state === 'down' && store.attach.message" class="ol-hint" style="margin-top: var(--ux-sp-2)">
          {{ store.attach.message }}
        </p>
        <p class="ol-hint" style="margin-top: var(--ux-sp-2)">
          attach 仅在 opencode 服务可达时生效；不可达不影响本地运行，守护每轮仍会把该地址传给 --attach。重启仅终止 opencode 进程，端口被其他程序占用时会拒绝操作。
        </p>
      </div>
    </template>

    <!-- TUI 历史会话：API 全局会话（真实标题），一键建任务 -->
    <div class="ol-card">
      <h3 class="ol-card__title">
        TUI 历史会话（全部项目）
        <UxChip v-if="history.total" tone="neutral">{{ history.total }} 条</UxChip>
        <UxChip v-if="history.source" tone="neutral">{{ history.source === 'api' ? 'API' : 'CLI' }}</UxChip>
        <span style="flex: 1"></span>
        <input
          class="ol-textarea"
          style="min-height: 0; padding: 2px var(--ux-sp-2); max-width: 240px"
          :value="history.filter"
          placeholder="按项目 / 标题 / ID / 模型过滤"
          aria-label="过滤历史会话"
          @input="(e) => (history.filter = e.target.value)"
        />
        <UxButton size="sm" variant="secondary" icon="act-retry" label="扫描历史会话" :loading="history.loading" @click="scanHistory">扫描</UxButton>
      </h3>
      <p v-if="!history.queried && !history.loading" class="ol-hint">
        点击「扫描」通过 opencode 本地 API 获取全部项目的会话（与 TUI 完全一致：真实标题/项目/模型/更新时间），可一键创建绑定该会话的守护任务。
      </p>
      <p v-if="history.error" class="ol-hint">{{ history.error }}</p>
      <div v-if="filteredHistory.length" class="ol-sess" style="max-height: 340px; overflow-y: auto">
        <div v-for="h in filteredHistory" :key="h.id" class="ol-sess__item">
          <UxChip tone="neutral">{{ h.projectName || '未知项目' }}</UxChip>
          <span class="ol-sess__title" :title="h.title">{{ h.title || 'New session' }}</span>
          <span class="ol-sess__id" :title="h.id">{{ h.id }}</span>
          <span v-if="h.model" class="ol-hint" :title="'使用模型 ' + h.model">{{ h.model }}</span>
          <span v-if="h.updated" class="ol-hint">{{ fmtTime(h.updated) }}</span>
          <UxTooltip content="创建绑定该会话的守护任务">
            <UxButton size="sm" variant="secondary" icon="act-plus" label="由该会话创建任务" @click="quickCreateFromSession(h)">建任务</UxButton>
          </UxTooltip>
          <UxTooltip content="删除该会话（不可恢复）">
            <UxButton
              size="sm"
              variant="ghost"
              icon="act-delete"
              label="删除会话"
              @click="askDeleteSession(h.id, h.dir, h.title)"
            />
          </UxTooltip>
        </div>
      </div>
      <p v-else-if="history.queried && !history.loading" class="ol-hint">未扫描到历史会话。</p>
      <p class="ol-hint" style="margin-top: var(--ux-sp-2)">
        数据源：opencode 本地 API（/api/session + /api/project，Basic 认证读取 service.json）；API 不可用时回退逐项目 CLI 扫描。
      </p>
    </div>
    <!-- 删除会话确认 -->
    <UxDialog v-model:open="delSess.open" title="删除会话">
      <p style="margin: 0 0 var(--ux-sp-2)">
        确认删除会话「{{ delSess.title || 'New session' }}」？
        <span class="ol-mono">{{ delSess.sessionId }}</span>
      </p>
      <p class="ol-note ol-note--warning">
        删除后不可恢复；若该会话被任务绑定，续写将失败。
      </p>
      <template #footer>
        <div class="ol-actions" style="justify-content: flex-end">
          <UxButton size="sm" variant="ghost" label="取消删除" @click="delSess.open = false">取消</UxButton>
          <UxButton size="sm" variant="danger" icon="act-delete" label="确认删除会话" :loading="delSess.loading" @click="confirmDeleteSession">删除</UxButton>
        </div>
      </template>
    </UxDialog>
  </div>
</template>
