<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { UxButton, UxChip, UxIcon, UxInput, UxSegmented, UxTooltip, notify } from '@ux/components'
import { store, setConfig, checkUpdate } from '../store'
import { api } from '../api'

const appVersion = __APP_VERSION__

const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

// ---------- 环境依赖检测 ----------

const envItems = ref([])
const envLoading = ref(false)
const envDetectedAt = ref(null)

async function detectEnv() {
  // 去重：路径未变化且已有结果时跳过（onMounted 与 config 加载触发的 watch 只跑一次）
  const path = store.config?.opencodePath || 'opencode'
  if (path === envLastPath && envItems.value.length) return
  envLastPath = path
  envLoading.value = true
  try {
    const r = await api.envDetect()
    envItems.value = r?.items || []
    envDetectedAt.value = r?.detectedAt || null
  } catch (err) {
    notify({ type: 'danger', message: `环境检测失败：${String(err?.message || err)}` })
  } finally {
    envLoading.value = false
  }
}

let envLastPath = null

// opencode 路径修改后自动重检（防抖）
let envDebounce = null
watch(
  () => store.config?.opencodePath,
  () => {
    clearTimeout(envDebounce)
    envDebounce = setTimeout(detectEnv, 800)
  }
)

onBeforeUnmount(() => clearTimeout(envDebounce))

function copyText(text) {
  navigator.clipboard?.writeText(text)
  notify({ type: 'info', message: '已复制' })
}

async function reveal(text) {
  const r = await api.revealPath(text)
  if (r && !r.ok) notify({ type: 'warning', message: r.error || '打开失败' })
}

async function copyReport() {
  const lines = [
    `OpenCodeLoop v${__APP_VERSION__}`,
    `数据目录：${dataDir.value.dir}（${dataDir.value.portable ? '便携模式' : '系统目录'}）`,
    '',
    ...envItems.value.map((i) => `${i.name}: ${i.ok ? i.version : '缺失'} | ${i.path || i.error || ''}${i.detail ? ' | ' + i.detail : ''}`)
  ]
  navigator.clipboard?.writeText(lines.join('\n'))
  notify({ type: 'success', message: '诊断报告已复制到剪贴板' })
}

// ---------- 数据目录 ----------

const dataDir = ref({ dir: '', portable: false })

// ---------- 开机自启 ----------

const loginBoot = ref(false)

async function toggleLogin(v) {
  try {
    const ok = await api.setLoginItem(v)
    loginBoot.value = ok
    await setConfig({ loginAtBoot: ok })
    notify({ type: ok ? 'success' : 'warning', message: ok ? '已开启：开机自动启动（托盘隐藏运行）' : '已关闭开机自启' })
  } catch (err) {
    notify({ type: 'danger', message: `设置开机自启失败：${String(err?.message || err)}` })
  }
}

// ---------- opencode 路径文件选择 ----------

async function pickExe() {
  const r = await api.pickFile(store.config.opencodePath)
  if (r && !r.canceled) setConfig({ opencodePath: r.path })
}

// ---------- 更新检测（只提醒，不自动下载） ----------

async function onCheckUpdate() {
  const r = await checkUpdate()
  if (r?.status === 'latest') notify({ type: 'success', message: `已是最新版本（v${appVersion}）` })
  else if (r?.status === 'none') notify({ type: 'info', message: '更新源还没有发布版本' })
  else if (r?.status === 'error') notify({ type: 'warning', message: `检查更新失败：${r.error || '未知原因'}` })
  else if (r?.status === 'available') notify({ type: 'info', message: `发现新版本 v${r.version}` })
}

async function openRelease() {
  const url = store.update.result?.url
  if (!url) return
  const r = await api.openExternal(url)
  if (r && !r.ok) notify({ type: 'warning', message: r.error || '打开失败' })
}

onMounted(async () => {
  detectEnv()
  try {
    const d = await api.dataDir()
    if (d) dataDir.value = d
    loginBoot.value = await api.getLoginItem()
  } catch {
    /* 数据目录/登录项读取失败保持缺省展示 */
  }
})
</script>

<template>
  <div class="ol-view" v-if="store.config">
    <div class="ol-card">
      <h3 class="ol-card__title">通用</h3>
      <div class="ol-form">
        <div class="ol-form-row">
          <UxInput
            :model-value="store.config.opencodePath"
            label="opencode 可执行文件"
            placeholder="opencode（默认从 PATH 解析）"
            hint="所有任务共用；可填绝对路径，留空则自动从 PATH 解析 npm shim 指向的真实 exe"
            @update:model-value="(v) => setConfig({ opencodePath: v })"
          />
          <UxButton size="sm" variant="secondary" icon="act-open-file" label="选择 opencode 可执行文件" @click="pickExe">浏览…</UxButton>
        </div>
        <label class="ol-check">
          <input
            type="checkbox"
            :checked="store.config.closeToTray"
            @change="(e) => setConfig({ closeToTray: e.target.checked })"
          />
          关闭窗口时最小化到托盘（不停止守护）
        </label>
        <label class="ol-check">
          <input type="checkbox" :checked="loginBoot" @change="(e) => toggleLogin(e.target.checked)" />
          随系统开机自动启动（托盘隐藏运行）
        </label>
      </div>
      <p class="ol-note" style="margin-top: var(--ux-sp-3)">
        <UxIcon name="st-info" />
        托盘图标常驻显示全部任务状态；项目目录 / 提示词 / 会话策略 / 模型 / 重启参数均属于任务——在「任务」页管理。
      </p>
    </div>

    <div class="ol-card">
      <h3 class="ol-card__title">
        更新检测
        <UxChip tone="neutral">v{{ appVersion }}</UxChip>
        <span style="flex: 1"></span>
        <UxButton
          size="sm"
          variant="secondary"
          icon="act-retry"
          label="检查更新"
          :loading="store.update.checking"
          @click="onCheckUpdate"
        >检查更新</UxButton>
      </h3>
      <div class="ol-form">
        <label class="ol-check">
          <input
            type="checkbox"
            :checked="store.config.checkUpdateOnStart"
            @change="(e) => setConfig({ checkUpdateOnStart: e.target.checked })"
          />
          启动时自动检查更新（仅提醒，不自动下载）
        </label>
        <template v-if="store.update.result">
          <div v-if="store.update.result.status === 'available'" class="ol-setrow">
            <span class="ol-setrow__label">发现新版本</span>
            <div class="ol-setrow__ctrl">
              <div class="ol-row">
                <span>
                  <strong>v{{ store.update.result.version }}</strong>
                  <span class="ol-hint">（当前 v{{ appVersion }}）</span>
                </span>
                <UxButton
                  v-if="store.update.result.url"
                  size="sm"
                  variant="primary"
                  label="前往发布页查看与下载"
                  @click="openRelease"
                >前往发布页</UxButton>
              </div>
              <pre
                v-if="store.update.result.notes"
                class="ol-hint"
                style="white-space: pre-wrap; max-height: 180px; overflow: auto; margin: 0"
              >{{ store.update.result.notes }}</pre>
            </div>
          </div>
          <p v-else-if="store.update.result.status === 'latest'" class="ol-hint">已是最新版本。</p>
          <p v-else-if="store.update.result.status === 'none'" class="ol-hint">更新源还没有发布版本。</p>
          <p v-else class="ol-hint">检查失败：{{ store.update.result.error }}</p>
        </template>
        <p class="ol-note" style="margin-top: var(--ux-sp-3)">
          <UxIcon name="st-info" />
          仅查询 GitHub Releases 的最新版本号并提醒，不会自动下载或安装；升级需自行前往发布页下载。
        </p>
      </div>
    </div>

    <div class="ol-card">
      <h3 class="ol-card__title">
        数据与目录
        <UxChip :tone="dataDir.portable ? 'success' : 'neutral'">{{ dataDir.portable ? '便携模式（安装目录）' : '系统目录' }}</UxChip>
        <span style="flex: 1"></span>
      </h3>
      <div class="ol-setrow">
        <span class="ol-setrow__label">数据目录</span>
        <div class="ol-setrow__ctrl">
          <div class="ol-row">
            <span class="ol-mono ol-env__path" :title="dataDir.dir">{{ dataDir.dir }}</span>
            <UxTooltip content="复制路径">
              <UxButton size="sm" variant="ghost" icon="act-copy" label="复制路径" @click="copyText(dataDir.dir)" />
            </UxTooltip>
            <UxTooltip content="在资源管理器中打开">
              <UxButton size="sm" variant="ghost" icon="act-open-file" label="打开目录" @click="reveal(dataDir.dir)" />
            </UxTooltip>
          </div>
          <span class="ol-hint">
            配置（config.json）、守护日志与孤儿进程快照均保存在此目录；便携模式下拷贝安装目录即可完整迁移。守护任务的运行日志默认写在各任务的项目目录（keep-alive.log）。
          </span>
        </div>
      </div>
    </div>

    <div class="ol-card">
      <h3 class="ol-card__title">
        环境依赖
        <UxChip v-if="envItems.length" tone="neutral">{{ envItems.filter((i) => i.ok).length }}/{{ envItems.length }} 可用</UxChip>
        <span style="flex: 1"></span>
        <span v-if="envDetectedAt" class="ol-hint">检测于 {{ new Date(envDetectedAt).toLocaleTimeString() }}</span>
        <UxTooltip content="复制诊断报告（用于反馈问题）">
          <UxButton size="sm" variant="ghost" icon="act-copy" label="复制诊断报告" @click="copyReport">报告</UxButton>
        </UxTooltip>
        <UxButton size="sm" variant="secondary" icon="act-retry" label="重新检测环境依赖" :loading="envLoading" @click="detectEnv">重新检测</UxButton>
      </h3>
      <div class="ol-env">
        <div v-for="it in envItems" :key="it.key" class="ol-env__row">
          <span class="ol-env__name">{{ it.name }}</span>
          <UxChip :tone="it.ok ? 'success' : 'danger'" dot>{{ it.ok ? '可用' : '缺失' }}</UxChip>
          <span class="ol-mono ol-env__ver">{{ it.version || '—' }}</span>
          <span class="ol-env__path" :title="it.path || it.error">{{ it.path || it.error }}</span>
          <template v-if="it.path">
            <UxTooltip content="复制路径">
              <UxButton size="sm" variant="ghost" icon="act-copy" label="复制路径" @click="copyText(it.path)" />
            </UxTooltip>
            <UxTooltip content="在资源管理器中显示">
              <UxButton size="sm" variant="ghost" icon="act-open-file" label="显示" @click="reveal(it.path)" />
            </UxTooltip>
          </template>
        </div>
      </div>
      <p v-for="it in envItems.filter((i) => i.detail)" :key="it.key + '-d'" class="ol-hint" style="margin-top: var(--ux-sp-1)">
        {{ it.name }}：{{ it.detail }}
      </p>
      <p class="ol-note" style="margin-top: var(--ux-sp-3)">
        <UxIcon name="st-info" />
        检测逻辑与守护启动一致（PATH → npm shim → 真实 exe）；修改上方 opencode 路径后会自动重新检测。
      </p>
    </div>

    <div class="ol-card">
      <h3 class="ol-card__title">外观</h3>
      <div class="ol-row">
        <UxSegmented
          :model-value="store.config.theme"
          aria-label="主题"
          :options="THEME_OPTIONS"
          @update:model-value="(v) => setConfig({ theme: v })"
        />
        <UxChip tone="neutral">即时生效</UxChip>
      </div>
    </div>
  </div>
</template>
