<script setup lang="ts">
import { computed, useId } from 'vue'

const props = withDefaults(
  defineProps<{
    id?: string
    modelValue?: string
    label?: string
    placeholder?: string
    hint?: string
    error?: string
    disabled?: boolean
    type?: 'text' | 'password' | 'search'
  }>(),
  { type: 'text' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const fallbackId = useId()
const inputId = computed(() => props.id ?? fallbackId)

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="ux-field">
    <label v-if="label" class="ux-field__label" :for="inputId">{{ label }}</label>
    <input
      :id="inputId"
      class="ux-input"
      :class="{ 'ux-input--invalid': error }"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-invalid="error ? 'true' : undefined"
      @input="onInput"
    />
    <span v-if="error" class="ux-field__error">{{ error }}</span>
    <span v-else-if="hint" class="ux-field__hint">{{ hint }}</span>
  </div>
</template>
