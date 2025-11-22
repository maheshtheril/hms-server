import { resolveIndustry } from "../industries/industryRegistry";
import * as HospitalWizard from "../industries/hospital/wizard";
import * as HospitalProvisioning from "../industries/hospital/provisioning";
import * as RetailWizard from "../industries/retail/wizard";
import * as RetailProvisioning from "../industries/retail/provisioning";
import * as MfgWizard from "../industries/manufacturing/wizard";
import * as MfgProvisioning from "../industries/manufacturing/provisioning";

const WIZARDS: any = {
  hospitalWizard: HospitalWizard,
  retailWizard: RetailWizard,
  manufacturingWizard: MfgWizard,
};

const PROVISIONERS: any = {
  hospitalProvisioning: HospitalProvisioning,
  retailProvisioning: RetailProvisioning,
  manufacturingProvisioning: MfgProvisioning,
};

export function getWizardForIndustry(key: string) {
  const def = resolveIndustry(key);
  if (!def) return null;
  return WIZARDS[def.wizard];
}

export function getProvisionerForIndustry(key: string) {
  const def = resolveIndustry(key);
  if (!def) return null;
  return PROVISIONERS[def.provisioning];
}
