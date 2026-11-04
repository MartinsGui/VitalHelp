import assert from 'node:assert/strict'
import test from 'node:test'
import { profileIsComplete } from '../../dist/backEnd/services/medical-profile.js'

const completeProfile = {
  name: 'Marina',
  surname: 'Oliveira',
  dateOfBirth: '1990-05-12',
  sex: 'Feminino',
  bloodType: 'O+',
  allergies: ['Nenhuma'],
  medications: [{ name: 'Medicamento', dose: '50 mg', frequency: '1 vez ao dia' }],
  conditions: ['Nenhuma'],
  surgeries: ['Nenhuma'],
}

test('marca como completo um perfil com dados clínicos válidos', () => {
  assert.equal(profileIsComplete(completeProfile), true)
})

test('não considera completo medicamento sem dose ou frequência', () => {
  assert.equal(profileIsComplete({
    ...completeProfile,
    medications: [{ name: 'Medicamento', dose: '', frequency: '' }],
  }), false)
})

test('não considera completo perfil sem alergias ou medicamentos', () => {
  assert.equal(profileIsComplete({ ...completeProfile, allergies: [] }), false)
  assert.equal(profileIsComplete({ ...completeProfile, medications: [] }), false)
})

test('permite declarar explicitamente que não há medicamentos', () => {
  assert.equal(profileIsComplete({ ...completeProfile, medications: ['Nenhuma'] }), true)
})

test('rejeita campos obrigatórios ausentes, vazios ou com tipo inválido', () => {
  assert.equal(profileIsComplete(null), false)
  assert.equal(profileIsComplete({ ...completeProfile, name: '  ' }), false)
  assert.equal(profileIsComplete({ ...completeProfile, dateOfBirth: undefined }), false)
  assert.equal(profileIsComplete({ ...completeProfile, allergies: 'Nenhuma' }), false)
  assert.equal(profileIsComplete({ ...completeProfile, medications: [null] }), false)
})

test('aceita item clínico e posologia com espaços excedentes', () => {
  assert.equal(profileIsComplete({
    ...completeProfile,
    allergies: ['  Alergia  '],
    medications: [{ name: ' Remédio ', dose: ' 10 mg ', frequency: ' 1x/dia ' }],
  }), true)
})

test('não aceita medicamento que omita dados da posologia', () => {
  assert.equal(profileIsComplete({
    ...completeProfile,
    medications: [{ name: 'Remédio', dose: '10 mg' }],
  }), false)
  assert.equal(profileIsComplete({
    ...completeProfile,
    medications: [{ name: 'Remédio', frequency: '1x/dia' }],
  }), false)
})
