import { createRequestController } from './request.mjs'
const controller = createRequestController()
const status = document.querySelector('#status')
const data = document.querySelector('#data')
const errorMessage = document.querySelector('#error')
const retry = document.querySelector('#retry')
async function onLoad() {
  if (controller.isLoading()) return
  status.textContent = 'loading'
  data.textContent = ''
  errorMessage.textContent = ''
  try {
    const profile = await controller.load('/api/profile')
    data.textContent = JSON.stringify(profile, null, 2)
    errorMessage.textContent = ''
    status.textContent = 'success'
    retry.hidden = true
  } catch (error) {
    status.textContent = 'failed'
    errorMessage.textContent = error.message
    retry.hidden = false
  }
}
document.querySelector('#load').addEventListener('click', onLoad)
retry.addEventListener('click', onLoad)
