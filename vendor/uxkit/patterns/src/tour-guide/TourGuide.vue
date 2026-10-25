<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { UxButton } from '@ux/components'
import { tryUseI18n } from '@ux/services'
import type { TourStep } from '../types'

const props = withDefaults(
  defineProps<{
    steps: TourStep[]
    /** 提供则完成后写 localStorage，下次挂载自动跳过 */
    storageKey?: string
    /** 是否挂载后自动启动（默认 true）；帮助按钮场景设为 false，由外部显式 start() */
    auto?: boolean
    /** 无障碍名称（红线 10） */
    label?: string
  }>(),
  { auto: true },
)

const emit = defineEmits<{ done: [] }>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const visible = ref(false)
const stepIndex = ref(0)
const step = computed(() => props.steps[stepIndex.value])
const isLast = computed(() => stepIndex.value === props.steps.length - 1)

interface Spot {
  top: number
  left: number
  width: number
  height: number
}
const spot = ref<Spot | null>(null)
const pop = ref({ x: 0, y: 0, centered: true })
const popRef = ref<HTMLElement | null>(null)
const cardRef = ref<HTMLElement | null>(null)
let raf = 0

/** 锚点不可见（缺失 / display:none / 零尺寸）按无目标处理 */
function findAnchor(selector: string | undefined): HTMLElement | null {
  if (!selector) return null
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return el
}

function place(): void {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    const el = findAnchor(step.value?.target)
    if (!el) {
      spot.value = null
      pop.value = { x: 0, y: 0, centered: true }
      return
    }
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
    void nextTick(() => {
      const rect = el.getBoundingClientRect()
      spot.value = { top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }
      const pw = Math.min(340, window.innerWidth - 24)
      const ph = popRef.value?.offsetHeight || 240
      let x = Math.max(12, Math.min(rect.left, window.innerWidth - pw - 12))
      let y = rect.bottom + 14
      let centered = false
      if (y + ph > window.innerHeight - 12) {
        y = rect.top - ph - 14
        if (y < 12) {
          y = Math.max(12, (window.innerHeight - ph) / 2)
          centered = true
        }
      }
      pop.value = { x: centered ? (window.innerWidth - pw) / 2 : x, y, centered }
    })
  })
}

function go(i: number): void {
  if (!props.steps.length) return
  stepIndex.value = Math.max(0, Math.min(props.steps.length - 1, i))
  place()
}

function start(): void {
  visible.value = true
  stepIndex.value = 0
  place()
  void nextTick(() => cardRef.value?.focus())
}

function finish(): void {
  if (props.storageKey) {
    try {
      localStorage.setItem(props.storageKey, '1')
    } catch {
      /* 隐私模式忽略 */
    }
  }
  visible.value = false
  emit('done')
}

function onKey(e: KeyboardEvent): void {
  if (!visible.value) return
  if (e.key === 'Escape') finish()
  else if (e.key === 'ArrowRight' || e.key === 'Enter') go(stepIndex.value + 1)
  else if (e.key === 'ArrowLeft') go(stepIndex.value - 1)
}

function onReflow(): void {
  if (visible.value && step.value?.target) place()
}

onMounted(() => {
  window.addEventListener('resize', onReflow)
  window.addEventListener('scroll', onReflow, true)
  window.addEventListener('keydown', onKey)
  const done = props.storageKey ? localStorage.getItem(props.storageKey) === '1' : false
  if (props.auto !== false && props.steps.length && !done) start()
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onReflow)
  window.removeEventListener('scroll', onReflow, true)
  window.removeEventListener('keydown', onKey)
  cancelAnimationFrame(raf)
})

defineExpose({ start, finish, go })
</script>

<template>
  <div v-if="visible" class="ux-tour" data-ux="tour" :class="{ 'ux-tour--dim': !spot }" :role="'dialog'" :aria-label="label ?? 'Tour'" aria-modal="true">
    <div
      v-if="spot"
      class="ux-tour__spot"
      data-ux-part="tour-spot"
      :style="{ top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px` }"
    />
    <div
      ref="cardRef"
      class="ux-tour__card"
      data-ux-part="tour-card"
      :class="{ 'ux-tour__card--centered': pop.centered }"
      :style="pop.centered ? {} : { left: `${pop.x}px`, top: `${pop.y}px` }"
      tabindex="-1"
    >
      <div class="ux-tour__step">{{ stepIndex + 1 }} / {{ steps.length }}</div>
      <div class="ux-tour__title">{{ step?.title }}</div>
      <div class="ux-tour__desc">
        <p v-for="(line, i) in (step?.desc ?? '').split('\n')" :key="i">{{ line }}</p>
      </div>
      <div class="ux-tour__actions">
        <UxButton size="sm" variant="ghost" @click="finish">{{ tr('patterns.tour.skip', '跳过引导') }}</UxButton>
        <span class="ux-tour__spacer" />
        <UxButton v-if="stepIndex > 0" size="sm" variant="secondary" @click="go(stepIndex - 1)">
          {{ tr('patterns.tour.prev', '上一步') }}
        </UxButton>
        <UxButton v-if="!isLast" size="sm" variant="primary" @click="go(stepIndex + 1)">
          {{ tr('patterns.tour.next', '下一步') }}
        </UxButton>
        <UxButton v-else size="sm" variant="primary" @click="finish">{{ tr('patterns.tour.finish', '完成') }}</UxButton>
      </div>
    </div>
  </div>
</template>
