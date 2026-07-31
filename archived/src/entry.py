from workers import WorkerEntrypoint
from app import run_stealth_pass

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        """Allows you to visit the worker's URL link from your phone

        to manually force a ticket scan out of schedule whenever you want.
        """
        run_stealth_pass(self.env)
        return Response("Stealth manual tracking sweep triggered successfully.")

    async def scheduled(self, event):
        """Natively catches Cloudflare cron clock ticks and runs your background engine loops."""
        return run_stealth_pass(self.env)

