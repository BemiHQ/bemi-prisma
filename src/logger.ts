import {blue} from 'kleur/colors'

export const logger = {
  tags: {
    info: blue('prisma:query'),
  },

  log: (...args: any[]) => {
    console.log(...args);
  },

  debug: (...args: any[]) => {
    if (process.env.BEMI_DEBUG === 'true') {
      const [message, ...rest] = args
      console.log(`>>[Bemi] ${message}`, ...rest);
    }
  },
}
