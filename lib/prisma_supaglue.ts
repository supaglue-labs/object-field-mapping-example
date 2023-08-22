import { PrismaClient } from '../prisma/generated/supaglue_client';

let prismaSupaglue: PrismaClient;

if (process.env.NODE_ENV === 'production') {
  prismaSupaglue = new PrismaClient();
} else {
  if (!global.prismaSupaglue) {
    global.prismaSupaglue = new PrismaClient();
  }
  prismaSupaglue = global.prismaSupaglue;
}

export default prismaSupaglue;