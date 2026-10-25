<script setup lang="ts">
import { useSlots } from 'vue'

withDefaults(
  defineProps<{
    /** 无障碍名称（红线 10） */
    ariaLabel?: string
  }>(),
  {},
)

const slots = useSlots()
</script>

<template>
  <div class="ux-toolbar" role="toolbar" :aria-label="ariaLabel" data-ux="panel-toolbar">
    <div v-if="slots.lead" class="ux-toolbar__seg" data-ux-part="toolbar-lead">
      <slot name="lead" />
    </div>
    <span v-if="slots.lead && slots.monitor" class="ux-sep" />
    <div v-if="slots.monitor" class="ux-toolbar__seg" data-ux-part="toolbar-monitor">
      <slot name="monitor" />
    </div>
    <span class="ux-spacer" />
    <div v-if="slots.actions" class="ux-toolbar__seg ux-toolbar__seg--actions" data-ux-part="toolbar-actions">
      <slot name="actions" />
    </div>
  </div>
</template>
