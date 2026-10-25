<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import UxSplitter from '../splitter/UxSplitter.vue'

const props = withDefaults(
  defineProps<{
    /** 第一窗格占比（0–1） */
    ratio: number
    /** horizontal = 左右分屏，vertical = 上下分屏 */
    orientation?: 'horizontal' | 'vertical'
    min?: number
    max?: number
    /** 无障碍名称（红线 10） */
    label?: string
  }>(),
  { orientation: 'horizontal', min: 0.2, max: 0.8 },
)

const emit = defineEmits<{ 'update:ratio': [value: number] }>()

const el = ref<HTMLElement | null>(null)
const size = ref(0)
let observer: ResizeObserver | null = null

onMounted(() => {
  observer = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    if (!rect) return
    size.value = props.orientation === 'horizontal' ? rect.width : rect.height
  })
  if (el.value) observer.observe(el.value)
})
onBeforeUnmount(() => observer?.disconnect())

const px = computed(() => (size.value > 0 ? Math.round(props.ratio * size.value) : 0))
const minPx = computed(() => Math.round(props.min * size.value))
const maxPx = computed(() => Math.round(props.max * size.value))

function onPx(value: number): void {
  if (size.value <= 0) return
  const ratio = Math.min(props.max, Math.max(props.min, value / size.value))
  emit('update:ratio', Math.round(ratio * 1000) / 1000)
}
</script>

<template>
  <div ref="el" class="ux-splitpane" :class="`ux-splitpane--${orientation}`" data-ux="splitpane">
    <div
      class="ux-splitpane__pane"
      data-ux-part="pane-first"
      :style="size > 0
        ? (orientation === 'horizontal' ? { width: `${px}px` } : { height: `${px}px` })
        : { flexBasis: `calc((100% - 4px) * ${ratio})` }"
    >
      <slot name="first" />
    </div>
    <UxSplitter
      :model-value="px"
      :orientation="orientation === 'horizontal' ? 'vertical' : 'horizontal'"
      :min="minPx"
      :max="maxPx"
      :label="label ?? '调整分屏比例'"
      @update:model-value="onPx"
    />
    <div class="ux-splitpane__pane" data-ux-part="pane-second">
      <slot name="second" />
    </div>
  </div>
</template>
