import { renderStudentTable } from './students.mjs'

const tableEl = document.querySelector('#table')
const statusEl = document.querySelector('#status')

async function loadStudents() {
  statusEl.textContent = 'loading'
  try {
    const response = await fetch('/api/students')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const students = await response.json()
    tableEl.textContent = renderStudentTable(students)
    statusEl.textContent = 'success'
  } catch (error) {
    statusEl.textContent = `failed: ${error.message}`
  }
}

document.querySelector('#load').addEventListener('click', () => {
  void loadStudents()
})
