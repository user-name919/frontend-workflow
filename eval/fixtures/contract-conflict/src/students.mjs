/**
 * Renders student rows from API payload.
 * Baseline schema: id + name only.
 */

export function formatStudentRow(student) {
  if (!student || typeof student !== 'object') {
    throw new Error('student must be an object')
  }
  const id = student.id
  const name = student.name
  if (id == null || name == null) {
    throw new Error('student requires id and name')
  }
  return `${id}\t${name}`
}

export function renderStudentTable(students) {
  const header = 'ID\tName'
  const rows = students.map(formatStudentRow)
  return [header, ...rows].join('\n')
}
