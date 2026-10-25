<script setup lang="ts">
defineProps<{ keys: string }>()
</script>

<template>
  <kbd class="ux-kbd">{{ keys }}</kbd>
</template>
