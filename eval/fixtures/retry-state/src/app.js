import { createRequestController } from './request.mjs'

const statusEl = document.querySelector('#status')
const dataEl = document.querySelector('#data')
const loadBtn = document.querySelector('#load')

const controller = createRequestController()

function setStatus(text) {
  statusEl.textContent = text
}

async function onLoad() {
  setStatus('loading')
  dataEl.textContent = ''
  try {
    const data = await controller.load('/api/profile')
    dataEl.textContent = JSON.stringify(data, null, 2)
    setStatus('success')
  } catch (error) {
    setStatus(`failed: ${error.message}`)
  }
}

loadBtn.addEventListener('click', () => {
  void onLoad()
})
