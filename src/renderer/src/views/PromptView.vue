<script setup>
import { computed, ref, watch } from 'vue'
import { UxButton, UxChip, UxDropdown, UxDialog, UxIcon, UxInput, notify } from '@ux/components'
import { store, tasks, currentTask, selectTask, saveTaskDebounced, saveTask } from '../store'

const BUILTIN_PRESETS = [
  {
    name: 'keep-alive 默认（.progress.md 驱动）',
    text: '读取 .progress.md，继续完成未完成的任务。全部完成后输出 DONE。请自主规划、执行、验证、迭代、反思，不得访问项目目录外的系统文件，不要中途请求确认或等待授权，失败就自己诊断修正并继续，直到任务通过验证。修改完自动提交，不要推送代码。'
  },
  {
    name: '测试修复循环',
    text: '运行项目测试套件，修复所有失败的用例并验证回归。全部通过后输出 DONE。不要请求确认，不要访问项目目录外的文件，修改后自动提交，不要推送代码。'
  },
  {
    name: '代码审查清理',
    text: '检查最近一次提交的改动，修复其中的缺陷、坏味道与遗漏的边界条件，运行相关验证后输出 DONE。不要请求确认，修改后自动提交，不要推送代码。'
  }
]

const taskItems = computed(() => tasks.value.map((t) => ({ id: t.id, label: t.name })))

const saveOpen = ref(false)
const presetName = ref('')
const draftText = ref('')

const presets = computed(() => [
  ...BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true })),
  ...store.config.promptPresets
])

const presetItems = computed(() =>
  presets.value.map((p, i) => ({ id: String(i), label: p.name + (p.builtin ? '（内置）' : '') }))
)

function applyPreset(item) {
  const p = presets.value[Number(item.id)]
  if (!p || !currentTask.value) return
  saveTask({ ...currentTask.value, prompt: p.text })
  notify({ type: 'success', message: `已套用预设：${p.name}` })
}

function applyToTask(text) {
  if (!currentTask.value) return
  saveTaskDebounced({ ...currentTask.value, prompt: text })
}

function setDoneKeyword(v) {
  if (!currentTask.value) return
  saveTask({ ...currentTask.value, doneKeyword: v.trim() })
}

function openSave() {
  draftText.value = currentTask.value?.prompt || ''
  presetName.value = ''
  saveOpen.value = true
}

function confirmSave() {
  const name = presetName.value.trim()
  const text = draftText.value
  if (!name || !text.trim()) {
    notify({ type: 'warning', message: '请填写预设名称' })
    return
  }
  const next = [...store.config.promptPresets.filter((p) => p.name !== name), { name, text }]
  setConfig({ promptPresets: next })
  saveOpen.value = false
  notify({ type: 'success', message: '预设已保存' })
}

const charCount = computed(() => (currentTask.value?.prompt || '').length)

const VARS_HINT = '支持变量：{{project}}（项目目录）、{{date}}、{{time}}。提示词随每轮重启自动生效，无需停止守护。'

// 切换任务时让输入框重渲染（避免残留上一任务内容）
const taskKey = computed(() => currentTask.value?.id || 'none')
watch(taskKey, () => {})
</script>

<template>
  <div class="ol-view" v-if="store.config">
    <div v-if="!currentTask" class="ol-card">
      <p class="ol-hint">尚无任务——请先在「任务」页创建守护任务。</p>
    </div>

    <template v-else>
      <div class="ol-row" style="margin-bottom: var(--ux-sp-3)">
        <span class="ol-hint">编辑任务</span>
        <UxDropdown :items="taskItems" :label="currentTask.name" icon="act-edit" @select="(i) => selectTask(i.id)" />
        <UxChip tone="neutral">{{ charCount }} 字</UxChip>
      </div>

      <div class="ol-card">
        <h3 class="ol-card__title">
          固定提示词
          <span style="flex: 1"></span>
          <UxDropdown :items="presetItems" label="套用预设" icon="act-open-file" @select="applyPreset" />
          <UxButton size="sm" variant="secondary" icon="act-save" label="保存为预设" @click="openSave">保存为预设</UxButton>
        </h3>

        <textarea
          :key="taskKey"
          class="ol-textarea"
          :value="currentTask.prompt"
          spellcheck="false"
          aria-label="固定提示词"
          placeholder="每一轮守护启动时传给 opencode 的提示词…"
          @input="(e) => applyToTask(e.target.value)"
        ></textarea>

        <p class="ol-note" style="margin-top: var(--ux-sp-2)">
          <UxIcon name="st-info" />
          {{ VARS_HINT }}
        </p>
      </div>

      <div class="ol-card">
        <h3 class="ol-card__title">完成标记</h3>
        <div class="ol-form-row" style="max-width: 480px">
          <UxInput
            :model-value="currentTask.doneKeyword"
            label="完成标记（输出中出现即停止该任务守护）"
            placeholder="DONE"
            hint="与 keep-alive.ps1 的 DONE 检测一致；留空表示永不自动停止"
            @update:model-value="setDoneKeyword"
          />
        </div>
        <p class="ol-note" style="margin-top: var(--ux-sp-3)">
          <UxIcon name="st-warning" />
          标记为子串匹配（大小写敏感）。检测到标记后不会立刻杀进程——等当前轮自然退出，保证 git commit 等收尾动作完成。
        </p>
      </div>

      <div class="ol-card" v-if="store.config.promptPresets.length">
        <h3 class="ol-card__title">我的预设</h3>
        <div class="ol-rules">
          <div v-for="(p, i) in store.config.promptPresets" :key="p.name" class="ol-rule">
            <span class="ol-sess__title" :title="p.text.slice(0, 80)">{{ p.name }}</span>
            <span style="flex: 1"></span>
            <UxTooltip content="套用到当前任务">
              <UxButton size="sm" variant="ghost" icon="act-check" label="套用" @click="applyPreset({ id: String(i + BUILTIN_PRESETS.length) })" />
            </UxTooltip>
            <UxTooltip content="删除此预设">
              <UxButton
                size="sm"
                variant="ghost"
                icon="act-delete"
                label="删除"
                @click="setConfig({ promptPresets: store.config.promptPresets.filter((_, j) => j !== i) })"
              />
            </UxTooltip>
          </div>
        </div>
      </div>

      <UxDialog v-model:open="saveOpen" title="保存为预设">
        <div class="ol-form" style="min-width: 380px">
          <UxInput v-model="presetName" label="预设名称" placeholder="如：迭代修复循环" @keydown.enter="confirmSave" />
          <p class="ol-hint">将以文本框内容保存为新预设。</p>
          <textarea class="ol-textarea" style="min-height: 110px" v-model="draftText" aria-label="预设内容"></textarea>
        </div>
        <template #footer>
          <div class="ol-actions" style="justify-content: flex-end">
            <UxButton size="sm" variant="ghost" label="取消保存" @click="saveOpen = false">取消</UxButton>
            <UxButton size="sm" variant="primary" icon="act-save" label="保存预设" @click="confirmSave">保存</UxButton>
          </div>
        </template>
      </UxDialog>
    </template>
  </div>
</template>
