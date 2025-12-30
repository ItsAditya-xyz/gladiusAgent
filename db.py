from dotenv import load_dotenv
import os
load_dotenv()
from supabase import create_client
from logging_utils import get_logger

logger = get_logger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
logger.debug("supabase client initialized")
