// server/src/industries/industryRegistry.ts
// ===========================================================
// Central registry for all industries supported by Zyntra ERP
// ===========================================================

export type IndustryDefinition = {
  key: string;
  label: string;

  // Frontend wizard loader keys
  wizard: string;

  // Provisioning backend module keys
  provisioning: string;
};

/* -----------------------------------------------------------
   REGISTRY (canonical definitions)
----------------------------------------------------------- */
export const IndustryRegistry: Record<string, IndustryDefinition> = {
  hospital: {
    key: "hospital",
    label: "Hospital / Healthcare",
    wizard: "hospitalWizard",
    provisioning: "hospitalProvisioning",
  },

  retail: {
    key: "retail",
    label: "Retail / POS",
    wizard: "retailWizard",
    provisioning: "retailProvisioning",
  },

  manufacturing: {
    key: "manufacturing",
    label: "Manufacturing / MRP",
    wizard: "manufacturingWizard",
    provisioning: "manufacturingProvisioning",
  },
};

export type IndustryKey = keyof typeof IndustryRegistry;

/* -----------------------------------------------------------
   Resolve industry definition
----------------------------------------------------------- */
export function resolveIndustry(key: string): IndustryDefinition | null {
  if (!key) return null;
  return IndustryRegistry[key.toLowerCase()] ?? null;
}

/* -----------------------------------------------------------
   Loader: Get backend provisioner dynamically

   Expected module format:
     export async function provision(tenantId, companyId, userId, payload) {}
----------------------------------------------------------- */
export async function getProvisionerForIndustry(industryKey: string) {
  const def = resolveIndustry(industryKey);
  if (!def) return null;

  const modulePath = `./${def.key}/provisioning`;

  try {
    const mod = await import(modulePath);

    if (mod && typeof mod.provision === "function") {
      return mod.provision;
    }

    console.error(`[IndustryRegistry] provisioning missing for ${industryKey}`);
    return null;
  } catch (err) {
    console.error(`[IndustryRegistry] Failed loading provisioner for ${industryKey}:`, err);
    return null;
  }
}

/* -----------------------------------------------------------
   Loader: Get FRONTEND wizard route string (Next.js)
----------------------------------------------------------- */
export function getWizardRouteForIndustry(industryKey: string): string | null {
  const def = resolveIndustry(industryKey);
  if (!def) return null;

  return `/onboarding/${def.key}`;
}

/* -----------------------------------------------------------
   List all industries
----------------------------------------------------------- */
export function listIndustries() {
  return Object.values(IndustryRegistry);
}
