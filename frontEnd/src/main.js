import QRCode from 'qrcode'

const screens = {
  welcome: document.querySelector('#welcome-screen'),
  signup: document.querySelector('#signup-screen'),
  login: document.querySelector('#login-screen'),
  workspace: document.querySelector('#workspace-screen'),
  profile: document.querySelector('#profile-screen'),
  privacy: document.querySelector('#privacy-screen'),
  'consultation-password': document.querySelector('#consultation-password-screen'),
  qr: document.querySelector('#qr-screen'),
  'public-consult': document.querySelector('#public-consult-screen'),
}

let currentUser = null
let workspaceStatus = null
let lastGeneratedConsultationPassword = null
let profileReadable = true
const publicId = window.location.pathname.match(/^\/consulta\/([A-Za-z0-9_-]+)\/?$/)?.[1]
const repeatableFields = {
  allergies: { label: 'Alergia', placeholder: 'Informe uma alergia ou escreva “Nenhuma”', required: true },
  medications: { label: 'Medicamento', placeholder: 'Informe o medicamento ou escreva “Nenhuma”', required: true },
  conditions: { label: 'Doença ou condição', placeholder: 'Se não houver, deixe em branco: será salvo “Nenhuma”' },
  surgeries: { label: 'Cirurgia', placeholder: 'Se não houver, deixe em branco: será salvo “Nenhuma”' },
}

function showScreen(name) {
  const activeScreen = screens[name]
  if (!activeScreen) return
  for (const [screenName, screen] of Object.entries(screens)) {
    const isActive = screenName === name
    screen.hidden = !isActive
    screen.classList.toggle('hidden', !isActive)
  }
  window.scrollTo(0, 0)
}

function setMessage(element, message, isError = true) {
  element.textContent = message
  element.classList.remove('hidden', 'text-rose-600', 'text-indigo-700')
  element.classList.add(isError ? 'text-rose-600' : 'text-indigo-700')
}

function clearProfileValidation() {
  const form = document.querySelector('#profile-form')
  form.querySelectorAll('[data-validation-error]').forEach((error) => error.remove())
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
    field.removeAttribute('aria-invalid')
    field.classList.remove('border-rose-500', 'focus:border-rose-500')
  })
}

function showProfileValidation(fieldErrors) {
  clearProfileValidation()
  const form = document.querySelector('#profile-form')
  const targets = []

  for (const [fieldPath, message] of Object.entries(fieldErrors)) {
    let target
    let messageContainer
    const medicationMatch = fieldPath.match(/^medications(?:\.(\d+)\.(name|dose|frequency))?$/)
    const clinicalMatch = fieldPath.match(/^(allergies|conditions|surgeries)(?:\.(\d+))?$/)
    if (medicationMatch) {
      const row = document.querySelector('[data-repeatable-list="medications"]').children[Number(medicationMatch[1] ?? 0)]
      const inputIndex = { name: 0, dose: 1, frequency: 2 }[medicationMatch[2] ?? 'name']
      target = row?.querySelectorAll('input')[inputIndex]
    } else if (clinicalMatch) {
      const rows = document.querySelector(`[data-repeatable-list="${clinicalMatch[1]}"]`)
      target = rows?.children[Number(clinicalMatch[2] ?? 0)]?.querySelector('textarea')
        ?? document.querySelector(`[data-repeatable-list="${clinicalMatch[1]}"] textarea`)
    } else {
      target = form.querySelector(`[name="${CSS.escape(fieldPath)}"]`)
    }

    if (!target) continue
    target.setAttribute('aria-invalid', 'true')
    target.classList.add('border-rose-500', 'focus:border-rose-500')
    messageContainer = document.createElement('span')
    messageContainer.dataset.validationError = ''
    messageContainer.className = 'text-[10px] font-medium leading-4 text-rose-700'
    messageContainer.textContent = message
    if (medicationMatch) {
      messageContainer.classList.add('col-span-2')
      target.insertAdjacentElement('afterend', messageContainer)
    } else if (clinicalMatch) {
      target.insertAdjacentElement('afterend', messageContainer)
    } else {
      target.closest('label')?.append(messageContainer)
    }
    targets.push(target)
  }

  if (targets.length) {
    targets[0].focus({ preventScroll: true })
    targets[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  if (response.status === 204) return null
  const contentType = response.headers.get('content-type') || ''
  let result
  if (contentType.includes('application/json')) {
    result = await response.json()
  } else {
    const message = (await response.text()).trim()
    result = { error: message || 'Não foi possível concluir a solicitação.' }
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(result.error || 'Não foi possível concluir a solicitação.'),
      { fieldErrors: result.fieldErrors, status: response.status },
    )
  }
  return result
}

function showGoogleError(message) {
  const activeScreen = Object.values(screens).find((screen) => !screen.hidden)
  const status = activeScreen?.querySelector('[data-google-message]')
    ?? document.querySelector('#welcome-auth-message')
  setMessage(status, message)
}

function updateWorkspace(status) {
  workspaceStatus = status
  const user = status.user
  currentUser = user
  const firstName = status.profile?.name || user.name?.split(/\s+/)[0] || 'Olá'
  document.querySelector('#workspace-title').textContent = `Olá, ${firstName}.`

  const complete = status.profileComplete
  const hasConsultationPassword = status.hasConsultationPassword
  document.querySelector('#profile-status-title').textContent = status.profileReadable === false
    ? 'Perfil médico inacessível'
    : complete
    ? 'Seu perfil médico está completo'
    : 'Seu perfil está pronto para começar'
  document.querySelector('#profile-status-description').textContent = status.profileReadable === false
    ? 'A chave atual não consegue abrir os dados criptografados deste perfil.'
    : complete
    ? 'Suas informações de saúde foram salvas com proteção.'
    : 'Preencha seus dados pessoais e informações clínicas para continuar.'

  const requirements = []
  if (status.profileReadable === false) {
    requirements.push('Restaure o SESSION_SECRET original ou substitua o perfil')
  } else if (!complete) requirements.push('Complete seu perfil médico')
  if (!hasConsultationPassword) requirements.push('Crie uma senha de consulta')
  document.querySelector('#profile-status-detail').textContent = requirements.length
    ? `Para liberar o QR Code: ${requirements.join(' e ')}.`
    : '✓ Perfil completo e código de consulta configurado.'

  document.querySelector('#workspace-qr-button').disabled = !status.canViewQr
  document.querySelector('#consultation-password-title').textContent = hasConsultationPassword
    ? 'Código de consulta configurado'
    : 'Código de consulta'
  document.querySelector('#generate-consultation-code').textContent = hasConsultationPassword
    ? 'Gerar novo código'
    : 'Gerar código de consulta'
}

async function enterWorkspace() {
  const status = await requestJson('/api/me')
  updateWorkspace(status)
  showScreen('workspace')
}

function showAuthError(form, error) {
  const message = form.querySelector('[data-form-message]')
  setMessage(message, error.message)
}

document.querySelectorAll('[data-go]').forEach((button) => {
  button.addEventListener('click', async () => {
    const screenName = button.dataset.go
    if (screenName === 'qr') {
      await openQrScreen()
      return
    }
    if (screenName === 'profile') {
      await openProfileScreen()
      return
    }
    showScreen(screenName)
  })
})

document.querySelectorAll('[data-auth-form]').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formData = Object.fromEntries(new FormData(form))
    const isSignup = form.dataset.authForm === 'signup'
    try {
      await requestJson(`/api/auth/${isSignup ? 'signup' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify(formData),
      })
      await enterWorkspace()
    } catch (error) {
      showAuthError(form, error)
    }
  })
})

document.querySelector('#continue-to-space').addEventListener('click', async () => {
  try {
    await enterWorkspace()
  } catch (error) {
    showGoogleError(error.message)
  }
})

async function logout() {
  try {
    await requestJson('/api/logout', { method: 'POST' })
    currentUser = null
    workspaceStatus = null
    document.querySelector('#welcome-actions').classList.remove('hidden')
    document.querySelector('#signed-in-panel').classList.add('hidden')
    document.querySelector('#welcome-auth-message').classList.add('hidden')
    showScreen('welcome')
  } catch (error) {
    showGoogleError(error.message)
  }
}

document.querySelector('#logout-button').addEventListener('click', logout)
document.querySelector('#workspace-logout').addEventListener('click', logout)

document.querySelectorAll('[data-auth-form]').forEach((form) => {
  form.addEventListener('input', () => {
    const message = form.querySelector('[data-form-message]')
    message.classList.add('hidden')
  })
})

async function openProfileScreen() {
  try {
    const result = await requestJson('/api/profile')
    const { profile } = result
    profileReadable = result.profileReadable !== false
    const warning = document.querySelector('#profile-unreadable-warning')
    warning.textContent = profileReadable
      ? ''
      : 'Não foi possível abrir o perfil salvo. Primeiro, tente restaurar no .env o SESSION_SECRET usado quando ele foi criado e reinicie o servidor. Se não tiver essa chave ou um backup, você pode preencher e salvar um novo perfil; isso substituirá os dados criptografados antigos, que não poderão ser recuperados.'
    warning.classList.toggle('hidden', profileReadable)
    const form = document.querySelector('#profile-form')
    for (const field of form.elements) {
      if (field.name && !repeatableFields[field.name] && profile) {
        field.value = profile[field.name] ?? ''
      }
    }
    for (const [name, config] of Object.entries(repeatableFields)) {
      const container = document.querySelector(`[data-repeatable-list="${name}"]`)
      container.replaceChildren()
      const values = Array.isArray(profile?.[name])
        ? profile[name]
        : typeof profile?.[name] === 'string' && profile[name].trim()
          ? [profile[name]]
          : []
      for (const value of values.length ? values : ['']) {
        addRepeatableEntry(container, name, config, value)
      }
    }
    resetClinicalAdditionControls()
    document.querySelector('#profile-message').classList.add('hidden')
    showScreen('profile')
  } catch (error) {
    const message = document.querySelector('#workspace-message')
    setMessage(message, error.message)
    showScreen('workspace')
  }
}

function addRepeatableEntry(container, name, config, value = '') {
  const row = document.createElement('div')
  row.className = name === 'medications' ? 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2' : 'flex items-start gap-2'

  const field = document.createElement(name === 'medications' ? 'input' : 'textarea')
  field.name = name
  if (name === 'medications') field.type = 'text'
  else field.rows = 2
  field.maxLength = 300
  field.required = Boolean(config.required)
  field.value = name === 'medications' && value && typeof value === 'object' ? value.name : value
  field.placeholder = config.placeholder
  field.setAttribute('aria-label', config.label)
  field.className = 'h-10 w-full min-w-0 rounded-md border border-slate-200 px-2 py-2 text-xs font-normal outline-none focus:border-indigo-500'

  let doseField
  let frequencyField
  if (name === 'medications') {
    const details = document.createElement('div')
    details.className = 'grid grid-cols-2 gap-2'
    const doseContainer = document.createElement('div')
    doseContainer.className = 'grid gap-1'
    doseField = document.createElement('input')
    doseField.type = 'text'
    doseField.maxLength = 100
    doseField.placeholder = 'Dose (ex.: 50 mg)'
    doseField.setAttribute('aria-label', 'Dose do medicamento')
    doseField.value = typeof value === 'object' && value ? value.dose ?? '' : ''
    doseField.className = field.className
    frequencyField = document.createElement('input')
    frequencyField.type = 'text'
    frequencyField.maxLength = 120
    frequencyField.placeholder = 'Frequência (ex.: 1 vez ao dia)'
    frequencyField.setAttribute('aria-label', 'Frequência do medicamento')
    frequencyField.value = typeof value === 'object' && value ? value.frequency ?? '' : ''
    frequencyField.className = field.className
    const updateMedicationRequirements = () => {
      const isNone = field.value.trim().toLowerCase() === 'nenhuma'
      doseField.required = Boolean(field.value.trim()) && !isNone
      frequencyField.required = Boolean(field.value.trim()) && !isNone
    }
    field.addEventListener('input', updateMedicationRequirements)
    updateMedicationRequirements()
    doseContainer.append(doseField)
    const frequencyContainer = document.createElement('div')
    frequencyContainer.className = 'grid gap-1'
    frequencyContainer.append(frequencyField)
    details.append(doseContainer, frequencyContainer)
    const inputs = document.createElement('div')
    inputs.className = 'grid gap-2'
    inputs.append(field, details)
    row.append(inputs)
  } else {
    row.append(field)
  }

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = 'Remover'
  remove.setAttribute('aria-label', `Remover ${config.label.toLowerCase()}`)
  remove.className = 'shrink-0 rounded-md px-2 py-2 text-[10px] font-medium text-rose-600 hover:bg-rose-50'
  remove.addEventListener('click', () => {
    if (container.children.length === 1) {
      field.value = ''
      if (doseField) doseField.value = ''
      if (frequencyField) frequencyField.value = ''
      return
    }
    row.remove()
    updateRepeatableButton(name)
  })

  row.append(remove)
  container.append(row)
  updateRepeatableButton(name)
}

function updateRepeatableButton(name) {
  const container = document.querySelector(`[data-repeatable-list="${name}"]`)
  const addButton = document.querySelector(`[data-add-entry="${name}"]`)
  for (const row of container.children) {
    row.querySelector('button').hidden = container.children.length === 1
  }
  const isAtLimit = container.children.length >= 20
  addButton.disabled = isAtLimit
  addButton.title = isAtLimit ? 'Limite de 20 itens atingido.' : ''
}

function resetClinicalAdditionControls() {
  document.querySelectorAll('[data-add-entry]').forEach((button) => {
    button.classList.add('hidden')
    button.classList.remove('flex')
  })
  document.querySelector('[data-enable-clinical-additions]').classList.remove('hidden')
  document.querySelector('[data-confirm-clinical-additions]').classList.add('hidden')
}

document.querySelector('[data-enable-clinical-additions]').addEventListener('click', () => {
  document.querySelector('[data-enable-clinical-additions]').classList.add('hidden')
  document.querySelector('[data-confirm-clinical-additions]').classList.remove('hidden')
  document.querySelectorAll('[data-add-entry]').forEach((button) => {
    button.classList.remove('hidden')
    button.classList.add('flex')
  })
})

document.querySelector('[data-confirm-clinical-additions]').addEventListener('click', () => {
  resetClinicalAdditionControls()
})

for (const button of document.querySelectorAll('[data-add-entry]')) {
  button.addEventListener('click', () => {
    const name = button.dataset.addEntry
    const container = document.querySelector(`[data-repeatable-list="${name}"]`)
    if (container.children.length >= 20) return
    addRepeatableEntry(container, name, repeatableFields[name])
  })
}

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const formData = new FormData(form)
  const profile = Object.fromEntries(formData)
  for (const name of Object.keys(repeatableFields)) {
    const entries = name === 'medications'
      ? [...document.querySelectorAll('[data-repeatable-list="medications"] > div')].map((row) => {
        const [nameField, doseField, frequencyField] = row.querySelectorAll('input')
        const medicationName = nameField.value.trim()
        return {
          name: medicationName,
          dose: medicationName.toLowerCase() === 'nenhuma' ? '' : doseField.value.trim(),
          frequency: medicationName.toLowerCase() === 'nenhuma' ? '' : frequencyField.value.trim(),
        }
      }).filter((medication) => medication.name)
      : formData.getAll(name).map((value) => value.trim()).filter(Boolean)
    profile[name] = entries.length || (name !== 'conditions' && name !== 'surgeries')
      ? entries
      : ['Nenhuma']
  }
  const message = document.querySelector('#profile-message')
  clearProfileValidation()
  message.classList.add('hidden')
  if (!profileReadable && !window.confirm(
    'O perfil antigo não pode ser descriptografado. Confirme apenas se você não consegue restaurar o SESSION_SECRET original nem possui backup. Salvar substituirá os dados antigos irreversivelmente. Deseja continuar?',
  )) {
    return
  }
  try {
    const status = await requestJson('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({
        ...profile,
        ...(profileReadable ? {} : { replaceUnreadableProfile: true }),
      }),
    })
    updateWorkspace(status)
    setMessage(message, 'Perfil médico salvo.', false)
    showScreen('workspace')
  } catch (error) {
    setMessage(message, error.message)
    if (error.fieldErrors) showProfileValidation(error.fieldErrors)
  }
})

document.querySelector('#profile-form').addEventListener('input', () => {
  clearProfileValidation()
  document.querySelector('#profile-message').classList.add('hidden')
})

document.querySelector('#profile-form').addEventListener('invalid', (event) => {
  const field = event.target
  field.setAttribute('aria-invalid', 'true')
  field.classList.add('border-rose-500', 'focus:border-rose-500')
  if (!field.parentElement.querySelector('[data-validation-error]')) {
    const validationMessage = document.createElement('span')
    validationMessage.dataset.validationError = ''
    validationMessage.className = 'text-[10px] font-medium leading-4 text-rose-700'
    validationMessage.textContent = field.validationMessage
    field.insertAdjacentElement('afterend', validationMessage)
  }
}, true)

document.querySelector('#generate-consultation-code').addEventListener('click', async () => {
  const message = document.querySelector('#consultation-password-message')
  if (workspaceStatus?.hasConsultationPassword
    && !window.confirm('Gerar outro código invalida imediatamente o código atual. Deseja continuar?')) {
    return
  }
  try {
    const result = await requestJson('/api/consultation-password/generate', {
      method: 'POST',
    })
    lastGeneratedConsultationPassword = result.consultationPassword
    document.querySelector('#generated-code-value').textContent = lastGeneratedConsultationPassword
    document.querySelector('#generated-code-panel').classList.remove('hidden')
    document.querySelector('#generate-consultation-code').textContent = 'Gerar outro código'
    setMessage(message, 'Código gerado. Compartilhe com segurança.', false)
    updateWorkspace(await requestJson('/api/me'))
  } catch (error) {
    setMessage(message, error.message)
  }
})

async function copyConsultationPassword(statusElement) {
  if (!lastGeneratedConsultationPassword) return
  try {
    await navigator.clipboard.writeText(lastGeneratedConsultationPassword)
    setMessage(statusElement, 'Código copiado.', false)
  } catch {
    setMessage(statusElement, 'Não foi possível copiar. Selecione e copie o código manualmente.')
  }
}

document.querySelector('#copy-consultation-code').addEventListener('click', () => {
  copyConsultationPassword(document.querySelector('#consultation-password-message'))
})
document.querySelector('#qr-copy-code').addEventListener('click', () => {
  copyConsultationPassword(document.querySelector('#qr-message'))
})

async function openQrScreen() {
  try {
    const { url } = await requestJson('/api/qr')
    document.querySelector('#qr-image').src = await QRCode.toDataURL(url, {
      width: 448,
      margin: 1,
      color: { dark: '#192f56', light: '#ffffff' },
    })
    document.querySelector('#qr-url').textContent = url
    document.querySelector('#qr-message').classList.add('hidden')
    const shareCodePanel = document.querySelector('#qr-share-code')
    shareCodePanel.classList.toggle('hidden', !lastGeneratedConsultationPassword)
    if (lastGeneratedConsultationPassword) {
      document.querySelector('#qr-share-code-value').textContent = lastGeneratedConsultationPassword
    }
    showScreen('qr')
  } catch (error) {
    const message = document.querySelector('#workspace-message')
    setMessage(message, error.message)
    showScreen('workspace')
  }
}

function addProfileItem(container, title, value) {
  const item = document.createElement('div')
  item.className = 'border-b border-indigo-100 py-2 last:border-0'
  const heading = document.createElement('h2')
  heading.className = 'text-[10px] font-semibold text-indigo-800'
  heading.textContent = title
  const text = document.createElement('p')
  text.className = 'mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-700'
  text.textContent = Array.isArray(value)
    ? value.length
      ? value.map((entry) => (
        entry && typeof entry === 'object'
          ? [entry.name, entry.dose, entry.frequency].filter(Boolean).join(' · ')
          : entry
      )).join('\n')
      : 'Nenhuma'
    : value || 'Não informado'
  item.append(heading, text)
  container.append(item)
}

function addPhoneProfileItem(container, title, phone) {
  if (!phone) return
  const item = document.createElement('div')
  item.className = 'border-b border-indigo-100 py-2 last:border-0'
  const heading = document.createElement('h2')
  heading.className = 'text-[10px] font-semibold text-indigo-800'
  heading.textContent = title
  const link = document.createElement('a')
  link.className = 'mt-1 inline-block text-xs font-semibold text-indigo-700 underline'
  link.href = `tel:${phone.replace(/[^\d+]/g, '')}`
  link.textContent = phone
  item.append(heading, link)
  container.append(item)
}

function addSensitiveProfileItem(container, title, value) {
  const entries = Array.isArray(value) ? value : value ? [value] : []
  const hasSensitiveInfo = entries.some((entry) => (
    typeof entry === 'string'
      ? entry.trim() && entry.trim().toLowerCase() !== 'nenhuma'
      : typeof entry?.name === 'string' && entry.name.trim().toLowerCase() !== 'nenhuma'
  ))
  const displayEntries = entries.map((entry) => (
    entry && typeof entry === 'object'
      ? [entry.name, entry.dose, entry.frequency].filter(Boolean).join(' · ')
      : entry
  ))
  const item = document.createElement('section')
  item.className = hasSensitiveInfo
    ? 'mt-3 rounded-lg border border-rose-100 bg-rose-50 p-3'
    : 'mt-3 rounded-lg border border-slate-200 bg-white p-3'
  const heading = document.createElement('h2')
  heading.className = `text-[10px] font-semibold uppercase tracking-wide ${hasSensitiveInfo ? 'text-rose-700' : 'text-slate-500'}`
  heading.textContent = hasSensitiveInfo && title === 'Alergia' ? 'Alergia informada' : title
  const text = document.createElement('p')
  text.className = `mt-2 whitespace-pre-wrap text-sm font-semibold leading-5 ${hasSensitiveInfo ? 'text-rose-800' : 'text-slate-700'}`
  text.textContent = hasSensitiveInfo ? displayEntries.join('\n') : 'Nenhuma'
  item.append(heading, text)
  container.append(item)
}

document.querySelector('#request-profile-deletion').addEventListener('click', () => {
  document.querySelector('#confirm-profile-deletion').classList.remove('hidden')
  document.querySelector('#request-profile-deletion').classList.add('hidden')
  document.querySelector('#delete-profile-message').classList.add('hidden')
})

document.querySelector('#cancel-profile-deletion').addEventListener('click', () => {
  document.querySelector('#confirm-profile-deletion').classList.add('hidden')
  document.querySelector('#request-profile-deletion').classList.remove('hidden')
})

document.querySelector('#confirm-profile-deletion-button').addEventListener('click', async () => {
  const message = document.querySelector('#delete-profile-message')
  const button = document.querySelector('#confirm-profile-deletion-button')
  button.disabled = true
  button.textContent = 'Excluindo...'
  button.classList.add('cursor-progress')
  button.setAttribute('aria-busy', 'true')
  try {
    await requestJson('/api/account', { method: 'DELETE' })
    lastGeneratedConsultationPassword = null
    currentUser = null
    workspaceStatus = null
    document.querySelector('#welcome-actions').classList.remove('hidden')
    document.querySelector('#signed-in-panel').classList.add('hidden')
    document.querySelector('#welcome-auth-message').classList.add('hidden')
    showScreen('welcome')
  } catch (error) {
    setMessage(message, error.message)
  } finally {
    button.disabled = false
    button.textContent = 'Confirmar exclusão da conta'
    button.classList.remove('cursor-progress')
    button.removeAttribute('aria-busy')
  }
})

function renderPublicProfile(profile) {
  const profileData = document.querySelector('#public-profile-data')
  const publicForm = document.querySelector('#public-consult-form')
  const message = document.querySelector('#public-consult-message')
  profileData.replaceChildren()
  const name = document.createElement('h2')
  name.className = 'text-lg font-bold text-slate-900'
  name.textContent = `${profile.name} ${profile.surname}`.trim()
  profileData.append(name)
  addProfileItem(profileData, 'Dados pessoais', `Sexo: ${profile.sex || 'Não informado'} · Tipo sanguíneo: ${profile.bloodType || 'Não informado'}`)
  const birthDate = profile.dateOfBirth
    ? profile.dateOfBirth.split('-').reverse().join('/')
    : 'Não informado'
  addProfileItem(profileData, 'Data de nascimento', birthDate)
  addSensitiveProfileItem(profileData, 'Alergia', profile.allergies)
  addSensitiveProfileItem(profileData, 'Medicamentos em uso', profile.medications)
  addProfileItem(profileData, 'Doenças / condições', profile.conditions)
  addProfileItem(profileData, 'Cirurgias', profile.surgeries)
  addProfileItem(
    profileData,
    'Contato de emergência',
    [profile.emergencyContactName, profile.emergencyContactRelationship].filter(Boolean).join(' · '),
  )
  addPhoneProfileItem(profileData, 'Telefone do contato', profile.emergencyContactPhone)
  const note = document.createElement('p')
  note.className = 'mt-4 text-[10px] leading-4 text-slate-500'
  note.textContent = 'Informações declaradas pelo titular. Esta ficha não substitui avaliação médica.'
  profileData.append(note)
  profileData.classList.remove('hidden')
  publicForm.classList.add('hidden')
  message.classList.add('hidden')
}

if (publicId) {
  showScreen('public-consult')
  const publicForm = document.querySelector('#public-consult-form')
  const message = document.querySelector('#public-consult-message')
  requestJson(`/api/public/${encodeURIComponent(publicId)}/profile`)
    .then(({ profile }) => renderPublicProfile(profile))
    .catch((error) => {
      if (error.status !== 401) setMessage(message, error.message)
    })
  publicForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      const { profile } = await requestJson(`/api/public/${encodeURIComponent(publicId)}/unlock`, {
        method: 'POST',
        body: JSON.stringify({ password: new FormData(publicForm).get('password') }),
      })
      renderPublicProfile(profile)
    } catch (error) {
      setMessage(message, error.message)
    }
  })
} else {
  document.querySelectorAll('[data-google-message]').forEach((element) => element.classList.add('hidden'))

  async function handleGoogleCredential({ credential }) {
    document.querySelectorAll('[data-google-message]').forEach((element) => element.classList.add('hidden'))
    try {
      await requestJson('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential }),
      })
      await enterWorkspace()
    } catch (error) {
      showGoogleError(error.message)
    }
  }

  async function initializeGoogleSignIn() {
    try {
      const { googleClientId } = await requestJson('/api/config')
      await new Promise((resolve, reject) => {
        if (window.google?.accounts?.id) {
          resolve()
          return
        }
        const script = document.createElement('script')
        script.src = 'https://accounts.google.com/gsi/client'
        script.async = true
        script.onload = resolve
        script.onerror = () => reject(new Error('Não foi possível carregar o login do Google.'))
        document.head.append(script)
      })
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleGoogleCredential,
        ux_mode: 'popup',
        auto_select: false,
      })
      for (const [screen, text] of [['signup', 'signup_with'], ['login', 'continue_with']]) {
        const container = document.querySelector(`#google-${screen}-button`)
        window.google.accounts.id.renderButton(container, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text,
          shape: 'rectangular',
          width: Math.min(Math.floor(container.parentElement.clientWidth), 360),
        })
      }

      const response = await fetch('/api/me')
      if (response.ok) {
        updateWorkspace(await response.json())
        document.querySelector('#welcome-actions').classList.add('hidden')
        document.querySelector('#signed-in-panel').classList.remove('hidden')
        document.querySelector('#signed-in-label').textContent = `Conectado como ${currentUser.name || currentUser.email}`
        showScreen('workspace')
      }
    } catch (error) {
      showGoogleError(`${error.message} Confira as configurações do OAuth e reinicie o servidor.`)
    }
  }

  initializeGoogleSignIn()
}
