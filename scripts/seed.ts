import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/lib/password";
import { encryptText } from "../src/lib/crypto";

function resolveSeedTenantId(): string {
  const fromSeedTenantId = process.env.SEED_TENANT_ID?.trim();
  if (fromSeedTenantId) return fromSeedTenantId;

  const fromSampleTenantId = process.env.SAMPLE_TENANT_ID?.trim();
  if (fromSampleTenantId) return fromSampleTenantId;

  return "tenant_demo";
}

async function main() {
  const tenantId = resolveSeedTenantId();
  const tenantName = process.env.SEED_TENANT_NAME ?? "Demo Property Manager";
  const defaultCurrency = process.env.TENANT_DEFAULT_CURRENCY ?? "GBP";
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "change-this-password";

  const hostawayClientId = process.env.HOSTAWAY_CLIENT_ID ?? "";
  const hostawayClientSecret = process.env.HOSTAWAY_CLIENT_SECRET ?? "";

  const hostawayAccountId = process.env.HOSTAWAY_ACCOUNT_ID?.trim() || null;

  const hasRealHostawayCreds =
    Boolean(hostawayClientId && hostawayClientSecret) &&
    !hostawayClientId.includes("[") &&
    !hostawayClientSecret.includes("[");

  const tenant = await prisma.tenant.upsert({
    where: { id: tenantId },
    update: {
      name: tenantName,
      defaultCurrency,
      timezone: process.env.DEFAULT_TIMEZONE ?? "Europe/London"
    },
    create: {
      id: tenantId,
      name: tenantName,
      defaultCurrency,
      timezone: process.env.DEFAULT_TIMEZONE ?? "Europe/London"
    }
  });

  const existingUser = await prisma.user.findUnique({
    where: {
      tenantId_email: {
        tenantId: tenant.id,
        email: adminEmail
      }
    }
  });

  if (!existingUser) {
    const passwordHash = await hashPassword(adminPassword);
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: adminEmail,
        passwordHash
      }
    });
    console.log(`Created admin user ${adminEmail} on tenant ${tenant.id}`);
  } else {
    console.log(`Admin user ${adminEmail} already exists — password left unchanged`);
  }

  if (hasRealHostawayCreds) {
    await prisma.hostawayConnection.upsert({
      where: { tenantId: tenant.id },
      update: {
        hostawayAccountId,
        hostawayClientId,
        hostawayClientSecretEncrypted: encryptText(hostawayClientSecret),
        status: "active"
      },
      create: {
        tenantId: tenant.id,
        hostawayAccountId,
        hostawayClientId,
        hostawayClientSecretEncrypted: encryptText(hostawayClientSecret),
        status: "active"
      }
    });
  }

  console.log("Seed complete", {
    tenantId: tenant.id,
    adminEmail,
    hasHostawayConnection: hasRealHostawayCreds
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
