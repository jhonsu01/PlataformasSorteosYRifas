// Crea un administrador. Uso (las variables evitan dejar la clave en el historial):
//
//   DATABASE_URL=postgres://... ADMIN_EMAIL=tu@correo.com ADMIN_PASSWORD='...' \
//     npm run create-admin
//
// Rol opcional: ADMIN_ROLE=SUPER_ADMIN | ADMIN | OPERATOR   (por defecto SUPER_ADMIN)
// Tras crearlo, entra en la app Admin y activa 2FA (obligatorio para ADMIN+).

import { config } from "./config.js";
import { createPostgresStore } from "./store-postgres.js";
import { hashPassword } from "./crypto-utils.js";

const email = process.env.ADMIN_EMAIL || process.argv[2];
const password = process.env.ADMIN_PASSWORD || process.argv[3];
const role = process.env.ADMIN_ROLE || process.argv[4] || "SUPER_ADMIN";

if (!config.databaseUrl) {
  console.error("Falta DATABASE_URL: el administrador debe crearse contra una base real.");
  process.exit(1);
}
if (!email || !password) {
  console.error("Uso: DATABASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run create-admin");
  process.exit(2);
}
if (String(password).length < 12) {
  console.error("La contrasena debe tener al menos 12 caracteres.");
  process.exit(2);
}
if (!["SUPER_ADMIN", "ADMIN", "OPERATOR"].includes(role)) {
  console.error(`Rol invalido: ${role}. Usa SUPER_ADMIN, ADMIN u OPERATOR.`);
  process.exit(2);
}

const store = await createPostgresStore(config.databaseUrl);
try {
  const user = await store.createAdmin({ email, passwordHash: await hashPassword(password), role });
  console.log(`Administrador creado: ${user.email} (${user.role})`);
  console.log("Siguiente paso: inicia sesion en la app Admin y activa el 2FA.");
} catch (e) {
  console.error("Error:", e.message);
  process.exitCode = 1;
} finally {
  await store.close();
}
