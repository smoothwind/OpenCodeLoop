<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { UxButton, UxChip, UxIcon, UxInput, UxSegmented, UxTooltip, notify } from '@ux/components'
import { ErrorState } from '@ux/patterns'
import { store, tasks, currentTask, selectTask, saveTask, setConfig } from '../store'
import { api } from '../api'

const LEVEL_OPTIONS = [
  { value: '', label: '未设置' },
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '询问' },
  { value: 'deny', label: '拒绝' }
]

const taskItems = computed(() => tasks.value.map((t) => ({ id: t.id, label: t.name })))

// ---------- 常用规则一键添加 ----------

const QUICK_RULES = [
  { pattern: 'git push', level: 'deny', hint: '禁止推送（无人值守推荐）' },
  { pattern: 'git status', level: 'allow', hint: '放行只读查询' },
  { pattern: 'rm -rf*', level: 'deny', hint: '禁止递归强删' },
  { pattern: '*', level: 'ask', hint: '其余全部询问' },
  { pattern: 'npm test', level: 'allow', hint: '放行跑测试' },
  { pattern: 'curl *', level: 'ask', hint: '网络请求询问' }
]

function quickAdd(rule) {
  const exist = perm.bash.find((r) => r.pattern.trim() === rule.pattern)
  if (exist) {
    exist.level = rule.level
    notify({ type: 'info', message: `已更新规则「${rule.pattern}」为 ${rule.level}` })
    return
  }
  perm.bash.push({ pattern: rule.pattern, level: rule.level })
}

// ---------- 重复模式检测 / 预览 ----------

const dupPatterns = computed(() => {
  const seen = new Map()
  for (const r of perm.bash) {
    const k = r.pattern.trim()
    if (k) seen.set(k, (seen.get(k) || 0) + 1)
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
})

function buildPermission() {
  const bash = {}
  let droppedDup = 0
  for (const r of perm.bash) {
    const key = r.pattern.trim()
    if (!key || !r.level) continue
    if (bash[key] !== undefined) droppedDup++
    bash[key] = r.level
  }
  const permission = {}
  if (perm.edit) permission.edit = perm.edit
  if (perm.webfetch) permission.webfetch = perm.webfetch
  if (Object.keys(bash).length) permission.bash = bash
  return { permission, droppedDup }
}

const previewJson = computed(() => {
  const { permission } = buildPermission()
  return JSON.stringify({ permission }, null, 2)
})

const ruleCount = computed(() => perm.bash.length)

const perm = reactive({
  loading: false,
  file: '',
  exists: false,
  error: '',
  edit: '',
  webfetch: '',
  bash: [] // [{ pattern, level }]
})

const loaded = ref(false)
const loadedFor = ref('')

async function load() {
  if (!currentTask.value) return
  perm.loading = true
  try {
    const r = await api.readPermissions(currentTask.value.id)
    perm.file = r?.file || ''
    perm.exists = !!r?.exists
    perm.error = r?.error || ''
    const p = r?.data?.permission || {}
    perm.edit = p.edit || ''
    perm.webfetch = p.webfetch || ''
    perm.bash = Object.entries(p.bash || {}).map(([pattern, level]) => ({ pattern, level }))
    loadedFor.value = currentTask.value.id
    loaded.value = true
  } finally {
    perm.loading = false
  }
}

async function save() {
  if (!currentTask.value) return
  const { permission, droppedDup } = buildPermission()
  if (droppedDup > 0) {
    notify({ type: 'warning', message: `存在 ${droppedDup} 条重复模式，保存时以靠后的规则为准` })
  }
  const r = await api.writePermissions(currentTask.value.id, permission)
  if (r?.ok) {
    notify({ type: 'success', message: `已写入 ${r.file}` })
    await load()
  } else {
    notify({ type: 'danger', message: r?.error || '写入失败' })
  }
}

function setApproval(auto) {
  if (!currentTask.value) return
  saveTask({ ...currentTask.value, autoApprove: auto })
  notify({
    type: auto ? 'success' : 'warning',
    message: auto ? '已切换为自动批准（--auto）' : '已切换为手动审批——无人值守下会卡在授权等待'
  })
}

function addRule() {
  perm.bash.push({ pattern: '', level: 'ask' })
}

function removeRule(i) {
  perm.bash.splice(i, 1)
}

const fileName = computed(() => perm.file || '（任务未配置项目目录）')

onMounted(load)
</script>

<template>
  <div class="ol-view" v-if="store.config">
    <div v-if="!currentTask" class="ol-card">
      <p class="ol-hint">尚无任务——请先在「任务」页创建守护任务。</p>
    </div>

    <template v-else>
      <div class="ol-row" style="margin-bottom: var(--ux-sp-3)">
        <span class="ol-hint">作用于任务</span>
        <UxDropdown :items="taskItems" :label="currentTask.name" icon="obj-key" @select="(i) => selectTask(i.id)" />
        <span class="ol-hint">项目：{{ currentTask.project || '未配置' }}</span>
      </div>

      <div class="ol-card">
        <h3 class="ol-card__title">权限审批模式（该任务守护进程级）</h3>
        <div class="ol-row">
          <UxSegmented
            :model-value="currentTask.autoApprove ? 'auto' : 'manual'"
            aria-label="审批模式"
            :options="[
              { value: 'auto', label: '自动批准' },
              { value: 'manual', label: '手动审批' }
            ]"
            @update:model-value="(v) => setApproval(v === 'auto')"
          />
          <span class="ol-hint">自动批准 = 为 opencode 追加 --auto 参数（自动同意未被显式拒绝的权限请求）</span>
        </div>
        <p v-if="currentTask.autoApprove" class="ol-note" style="margin-top: var(--ux-sp-3)">
          <UxIcon name="st-info" />
          无人值守模式建议保持自动批准；可配合下方 opencode.json 的 deny 规则限制危险操作（如 git push）。
        </p>
        <p v-else class="ol-note ol-note--warning" style="margin-top: var(--ux-sp-3)">
          <UxIcon name="st-warning" />
          手动审批无法在无人值守下应答授权请求——opencode 会一直等待并最终超时重启，形成空转。除非有人值守，否则请切回自动批准。
        </p>
      </div>

      <div class="ol-card">
        <h3 class="ol-card__title">
          项目权限规则（{{ fileName }}）
          <UxChip tone="neutral">{{ ruleCount }} 条规则</UxChip>
          <span style="flex: 1"></span>
          <UxButton size="sm" variant="ghost" icon="act-retry" label="重新加载配置" :loading="perm.loading" @click="load">重新加载</UxButton>
        </h3>

        <ErrorState
          v-if="perm.error"
          :error="perm.error"
          title="配置文件解析失败"
          summary="opencode.json 存在语法错误（注释 / 尾逗号之外的非法 JSON），为避免覆盖已禁止写入"
          :on-retry="load"
        />

        <template v-else-if="loaded && loadedFor === currentTask.id">
          <p class="ol-hint" style="margin-bottom: var(--ux-sp-3)">
            写入目标项目根目录的 opencode.json（不存在则创建）；其余配置键原样保留。
          </p>

          <div class="ol-form" style="gap: var(--ux-sp-3)">
            <div class="ol-form-row">
              <UxInput model-value="文件编辑（edit）" label="作用范围" disabled hint="agent 修改项目文件的权限" />
              <UxSegmented
                :model-value="perm.edit"
                aria-label="edit 权限"
                :options="LEVEL_OPTIONS"
                @update:model-value="(v) => (perm.edit = v)"
              />
            </div>
            <div class="ol-form-row">
              <UxInput model-value="网页抓取（webfetch）" label="作用范围" disabled hint="访问外部 URL 的权限" />
              <UxSegmented
                :model-value="perm.webfetch"
                aria-label="webfetch 权限"
                :options="LEVEL_OPTIONS"
                @update:model-value="(v) => (perm.webfetch = v)"
              />
            </div>
          </div>

          <h3 class="ol-card__title" style="margin-top: var(--ux-sp-4)">
            Bash 命令规则（模式 → 权限）
            <span class="ol-hint">支持 * 通配；重复模式以靠后一条为准</span>
          </h3>

          <div class="ol-row" style="margin-bottom: var(--ux-sp-2)">
            <span class="ol-hint">快捷添加：</span>
            <button
              v-for="qr in QUICK_RULES"
              :key="qr.pattern"
              class="ol-conf__item"
              :title="qr.hint"
              @click="quickAdd(qr)"
            >
              <span class="ol-conf__k">{{ qr.pattern }}</span>
              <span class="ol-conf__v">{{ qr.level }}</span>
            </button>
          </div>

          <p v-if="dupPatterns.length" class="ol-note ol-note--warning" style="margin-bottom: var(--ux-sp-2)">
            <UxIcon name="st-warning" />
            重复模式：{{ dupPatterns.join('、') }} —— 保存时以靠后一条为准
          </p>

          <div class="ol-rules">
            <div v-for="(r, i) in perm.bash" :key="i" class="ol-rule">
              <UxInput
                :model-value="r.pattern"
                :label="i === 0 ? '命令模式' : undefined"
                placeholder="如 git push 或 *（通配全部）"
                @update:model-value="(v) => (r.pattern = v)"
              />
              <UxSegmented
                :model-value="r.level"
                size="sm"
                :aria-label="`规则 ${i + 1} 权限`"
                :options="LEVEL_OPTIONS.slice(1)"
                @update:model-value="(v) => (r.level = v)"
              />
              <UxTooltip content="删除该规则">
                <UxButton size="sm" variant="ghost" icon="act-delete" label="删除规则" @click="removeRule(i)" />
              </UxTooltip>
            </div>
          </div>
          <div class="ol-actions" style="margin-top: var(--ux-sp-3)">
            <UxButton size="sm" variant="secondary" icon="act-plus" label="添加规则" @click="addRule">添加规则</UxButton>
            <UxButton size="sm" variant="primary" icon="act-save" label="保存到项目配置" @click="save">保存到项目配置</UxButton>
          </div>

          <details style="margin-top: var(--ux-sp-3)">
            <summary class="ol-hint" style="cursor: pointer">预览将写入的权限块</summary>
            <pre class="ol-raw" style="margin-top: var(--ux-sp-2)">{{ previewJson }}</pre>
          </details>
          <p class="ol-note" style="margin-top: var(--ux-sp-3)">
            <UxIcon name="st-info" />
            推荐组合：自动批准 + <code>git push → deny</code>：无人值守时 agent 可自主执行命令，但推送被硬拒绝，代码只留在本地提交。
          </p>
        </template>
      </div>
    </template>
  </div>
</template>
