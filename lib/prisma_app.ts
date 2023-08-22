import { PrismaClient } from '../prisma/generated/app_client';

let prismaApp: PrismaClient;

if (process.env.NODE_ENV === 'production') {
  prismaApp = new PrismaClient();
} else {
  if (!global.prismaApp) {
    global.prismaApp = new PrismaClient();
  }
  prismaApp = global.prismaApp;
}

export default prismaApp;