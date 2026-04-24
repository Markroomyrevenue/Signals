import { prisma } from "@/lib/prisma";

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class FxConverter {
  private cache = new Map<string, number>();

  async getRate(date: Date, fromCurrency: string, toCurrency: string): Promise<number> {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) return 1;

    const dateKey = toDateOnly(date);
    const key = `${dateKey}:${from}:${to}`;
    if (this.cache.has(key)) {
      return this.cache.get(key) ?? 1;
    }

    const direct = await prisma.fxRate.findFirst({
      where: {
        baseCurrency: from,
        quoteCurrency: to,
        date: {
          lte: new Date(`${dateKey}T00:00:00Z`)
        }
      },
      orderBy: {
        date: "desc"
      },
      select: {
        rate: true
      }
    });

    if (direct) {
      const rate = Number(direct.rate);
      this.cache.set(key, rate);
      return rate;
    }

    const inverse = await prisma.fxRate.findFirst({
      where: {
        baseCurrency: to,
        quoteCurrency: from,
        date: {
          lte: new Date(`${dateKey}T00:00:00Z`)
        }
      },
      orderBy: {
        date: "desc"
      },
      select: {
        rate: true
      }
    });

    if (inverse) {
      const inverseRate = Number(inverse.rate);
      const rate = inverseRate > 0 ? 1 / inverseRate : 1;
      this.cache.set(key, rate);
      return rate;
    }

    this.cache.set(key, 1);
    return 1;
  }

  async convert(
    amount: number,
    date: Date,
    fromCurrency: string,
    toCurrency: string
  ): Promise<number> {
    const rate = await this.getRate(date, fromCurrency, toCurrency);
    return amount * rate;
  }
}
