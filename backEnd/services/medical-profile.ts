interface Medication {
  name?: unknown
  dose?: unknown
  frequency?: unknown
}

export interface MedicalProfile {
  name?: unknown
  surname?: unknown
  dateOfBirth?: unknown
  sex?: unknown
  bloodType?: unknown
  allergies?: unknown
  medications?: unknown
  conditions?: unknown
  surgeries?: unknown
}

export function profileIsComplete(profile: MedicalProfile | null) {
  const clinicalFields = [profile?.allergies, profile?.conditions, profile?.surgeries]
  const medications = profile?.medications
  const medicationsAreComplete = Array.isArray(medications)
    && medications.length > 0
    && medications.every((medication: unknown) => {
      if (typeof medication === 'string') return medication.trim().toLowerCase() === 'nenhuma'
      if (!medication || typeof medication !== 'object') return false
      const { name, dose, frequency } = medication as Medication
      if (typeof name !== 'string' || !name.trim()) return false
      return name.trim().toLowerCase() === 'nenhuma'
        || (typeof dose === 'string' && Boolean(dose.trim())
          && typeof frequency === 'string' && Boolean(frequency.trim()))
    })

  return Boolean(
    typeof profile?.name === 'string' && profile.name.trim()
    && typeof profile.surname === 'string' && profile.surname.trim()
    && typeof profile.dateOfBirth === 'string' && profile.dateOfBirth
    && typeof profile.sex === 'string' && profile.sex.trim()
    && typeof profile.bloodType === 'string' && profile.bloodType.trim()
    && medicationsAreComplete
    && clinicalFields.every((items) => (
      Array.isArray(items) && items.some((item) => typeof item === 'string' && item.trim())
    ))
  )
}
