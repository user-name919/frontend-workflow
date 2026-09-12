import { createNotice, renderNotice } from './notice.mjs'

const out = document.querySelector('#notice')
const titleInput = document.querySelector('#title')

document.querySelector('#publish').addEventListener('click', () => {
  try {
    const notice = createNotice({ title: titleInput.value })
    out.textContent = renderNotice(notice)
  } catch (error) {
    out.textContent = `error: ${error.message}`
  }
})
