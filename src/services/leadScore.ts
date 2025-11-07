export function computeLeadScore(lead: any) {
  let score = 0;
  if (Number(lead.estimated_value) > 0) score += 20;
  if (Number(lead.probability) > 20) score += 20;
  if (lead.primary_email) score += 10;
  if (lead.primary_phone) score += 10;
  if (lead.industry_id) score += 10;
  if (lead.profession_id) score += 10;
  return Math.min(100, score);
}
