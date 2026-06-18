"""change_task_step_to_varchar

Revision ID: 20250618_042448
Revises:
Create Date: 2026-06-18 04:24:48.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20250618_042448'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Convert tasks.step from ENUM to VARCHAR(50) so new steps like
    # cellchat_pathway / infercnv / wgcna / monocle don't hit
    # "Data truncated for column 'step'" on INSERT.
    op.alter_column(
        'tasks',
        'step',
        existing_type=sa.Enum(
            'qc', 'normalize', 'reduce', 'cluster', 'markers', 'enrich',
            'annotate', 'convert', 'markers_pairwise', 'plot_markers',
            name='task_step',
        ),
        type_=sa.String(length=50),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        'tasks',
        'step',
        existing_type=sa.String(length=50),
        type_=sa.Enum(
            'qc', 'normalize', 'reduce', 'cluster', 'markers', 'enrich',
            'annotate', 'convert', 'markers_pairwise', 'plot_markers',
            name='task_step',
        ),
        existing_nullable=False,
    )
