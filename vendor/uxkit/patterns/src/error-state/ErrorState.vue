<script setup lang="ts">
import { computed, ref } from 'vue'
import { UxButton, UxIcon, notify } from '@ux/components'
import { tryUseI18n } from '@ux/services'
import { looksLikeConnError } from './looks-like-conn-error'

const props = withDefaults(
  defineProps<{
    /** 错误详情（原始报错链，mono 字体） */
    error: string
    /** 标题；缺省按连接类/普通错误自动选择 */
    title?: string
    /** 一行可操作摘要（面向用户）；提供后详情默认折叠，可展开（SPEC-CONN-1） */
    summary?: string
    /** 普通错误动作：重试 */
    onRetry?: () => void
    /** 连接类错误动作：重连（连接类错误时替代"重试"出现） */
    onReconnect?: () => void
    /** 可选动作：查看日志 */
    onOpenLog?: () => void
  }>(),
  {},
)

/** 有摘要时详情默认收起，逐层展开：一行摘要 → 原始详情 */
const showDetail = ref(!props.summary)

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const isConn = computed(() => looksLikeConnError(props.error))
const heading = computed(() => {
  if (props.title) return props.title
  return isConn.value
    ? tr('patterns.error.connTitle', '连接出现问题')
    : tr('patterns.error.title', '操作失败')
})

async function copyDetail(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.error)
    notify({ type: 'success', message: tr('patterns.error.copied', '错误详情已复制') })
  } catch {
    notify({ type: 'danger', message: tr('patterns.error.copyFailed', '复制失败') })
  }
}
</script>

<template>
  <div class="ux-error" data-ux="error" role="alert">
    <UxIcon name="st-error" class="ux-error__icon" />
    <div class="ux-error__title">{{ heading }}</div>
    <p v-if="summary" class="ux-error__summary">{{ summary }}</p>
    <pre v-if="showDetail" class="ux-error__detail">{{ error }}</pre>
    <div class="ux-error__actions">
      <UxButton
        v-if="isConn && onReconnect"
        size="sm"
        variant="primary"
        icon="act-retry"
        @click="onReconnect"
      >
        {{ tr('patterns.error.reconnect', '重连') }}
      </UxButton>
      <UxButton v-else-if="onRetry" size="sm" variant="primary" icon="act-retry" @click="onRetry">
        {{ tr('patterns.error.retry', '重试') }}
      </UxButton>
      <UxButton size="sm" variant="ghost" icon="act-copy" @click="copyDetail">
        {{ tr('patterns.error.copy', '复制详情') }}
      </UxButton>
      <UxButton v-if="onOpenLog" size="sm" variant="ghost" @click="onOpenLog">
        {{ tr('patterns.error.openLog', '查看日志') }}
      </UxButton>
      <UxButton
        v-if="summary"
        size="sm"
        variant="ghost"
        :icon="showDetail ? 'act-chevron-down' : 'act-chevron-right'"
        @click="showDetail = !showDetail"
      >
        {{ showDetail ? tr('patterns.error.hideDetail', '隐藏详情') : tr('patterns.error.showDetail', '显示详情') }}
      </UxButton>
    </div>
  </div>
</template>
