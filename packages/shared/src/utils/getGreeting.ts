export function getGreeting(name?: string): string {
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return name ? `${timeOfDay}, ${name}` : timeOfDay;
}
