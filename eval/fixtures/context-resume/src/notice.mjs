/**
 * Notice board helpers.
 * Baseline: title only. Subtitle support is intentionally absent.
 */

export function createNotice({ title }) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('title is required')
  }
  return {
    title: title.trim(),
  }
}

export function renderNotice(notice) {
  return `Title: ${notice.title}`
}
