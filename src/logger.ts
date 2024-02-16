export const log = (...args: any[]) => {
  if (process.env.BEMI_DEBUG === 'true') {
    const [message, ...rest] = args
    console.log(`>>[Bemi] ${message}`, ...rest);
  }
}
