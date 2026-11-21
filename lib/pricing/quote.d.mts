export function lockUsagePrice(client: any, event: any): Promise<any>;
export function quoteUsage(price: any, channelMultiplier: string | number, event: any): any;
export function decimalToScaled(value: string | number, scaleDigits?: number): bigint;
export function resolveServiceTier(event?: any): string;
export function selectPriceTier(tiers: any[], context: any): { index: number; tier: any } | null;
