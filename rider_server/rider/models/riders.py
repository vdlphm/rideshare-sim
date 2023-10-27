import uuid

from django.contrib.auth.models import PermissionsMixin, UserManager, AbstractUser
from django.core.validators import MinLengthValidator
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from rider.models.managers import RiderManager


class Rider(AbstractUser):
    class Meta:
        verbose_name = _("rider")
        verbose_name_plural = _("rider")

    id = models.UUIDField(_("Rider ID"), primary_key=True, default=uuid.uuid4)

    # Login info
    email = models.EmailField(_("Rider email address"), unique=True, max_length=320, validators=[MinLengthValidator(1)])
    password = models.CharField(_("password"), max_length=128, validators=[MinLengthValidator(1)])

    # Basic info
    username = None
    first_name = models.CharField(_("Rider first name"), max_length=50, validators=[MinLengthValidator(1)])
    last_name = models.CharField(_("Rider last name"), max_length=50, validators=[MinLengthValidator(1)])

    # Date
    date_joined = models.DateTimeField(default=timezone.now)

    objects = RiderManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["first_name", "last_name"]

    def __str__(self):
        return self.email
